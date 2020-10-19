/**
 * this plugin adds the RxCollection.syncGraphQl()-function to rxdb
 * you can use it to sync collections with remote graphql endpoint
 */
import { Octokit } from '@octokit/rest';
import { OctokitResponse, ReposCreateOrUpdateFileContentsResponse201Data, ReposCreateOrUpdateFileContentsResponseData, ReposGetCommitResponseData } from '@octokit/types';

import {
    BehaviorSubject,
    Subject,
    Subscription,
    Observable
} from 'rxjs';
import {
    first,
    filter, throwIfEmpty
} from 'rxjs/operators';
import GraphQLClient from 'graphql-client';


import {
    promiseWait,
    flatClone,
    now
} from '../../util';

import {
    addRxPlugin
} from '../../core';
import {
    hash
} from '../../util';

import {
    DEFAULT_MODIFIER,
    wasRevisionfromPullReplication,
    createRevisionForPulledDocument,
    getDocsWithRevisionsFromPouch
} from './helper';
import {
    setLastPushSequence,
    getLastPullDocument,
    setLastPullDocument,
    getChangesSinceLastPushSequence
} from './crawling-checkpoint';

import { RxDBWatchForChangesPlugin } from '../watch-for-changes';
import { RxDBLeaderElectionPlugin } from '../leader-election';
import {
    changeEventfromPouchChange
} from '../../rx-change-event';
import type {
    RxCollection,
    GitHubSyncPushOptions,
    RxPlugin, GitHubOptions
} from '../../types';

addRxPlugin(RxDBLeaderElectionPlugin);

/**
 * add the watch-for-changes-plugin
 * so pouchdb will emit events when something gets written to it
 */
addRxPlugin(RxDBWatchForChangesPlugin);


export class RxGitHubReplicationState {
    private octokit: Octokit;
    constructor(
        public collection: RxCollection,
        private url: string,
        headers: { [k: string]: string },
        public github: GitHubOptions,
        public push: GitHubSyncPushOptions,
        public deletedFlag: string,
        public lastPulledRevField: string,
        public live: boolean,
        public liveInterval: number,
        public retryTime: number,
        public syncRevisions: boolean
    ) {
        this.octokit = new Octokit({
            auth: this.github.auth
        });

        this.client = GraphQLClient({
            url,
            headers
        });
        this.endpointHash = hash(url);
        this._prepare();
    }
    public client: any;
    public endpointHash: string;
    public _subjects = {
        recieved: new Subject(), // all documents that are recieved from the endpoint
        send: new Subject(), // all documents that are send to the endpoint
        error: new Subject(), // all errors that are revieced from the endpoint, emits new Error() objects
        canceled: new BehaviorSubject(false), // true when the replication was canceled
        active: new BehaviorSubject(false), // true when something is running, false when not
        initialReplicationComplete: new BehaviorSubject(false) // true the initial replication-cycle is over
    };
    public _runningPromise: Promise<void> = Promise.resolve();
    public _subs: Subscription[] = [];

    public _runQueueCount: number = 0;
    public _runCount: number = 0; // used in tests

    // ..$ are getters created in _prepare() for observables

    public initialReplicationComplete$: Observable<any> = undefined as any; // getter for the BehaviorSubject 'initialReplicationComplete'
    public recieved$: Observable<any> = undefined as any;
    public send$: Observable<any> = undefined as any;
    public error$: Observable<any> = undefined as any;
    public canceled$: Observable<any> = undefined as any;
    public active$: Observable<boolean> = undefined as any;

    private cacheOfGitHubContentSHA = new Map();

    /**
     * things that are more complex to not belong into the constructor
     */
    _prepare() {
        // stop sync when collection gets destroyed
        this.collection.onDestroy.then(() => {
            this.cancel();
        });

        // create getters for the observables
        Object.keys(this._subjects).forEach(key => {
            Object.defineProperty(this, key + '$', {
                get: function () {
                    return this._subjects[key].asObservable();
                }
            });
        });
    }

    isStopped(): boolean {
        if (!this.live && this._subjects.initialReplicationComplete['_value']) return true;
        if (this._subjects.canceled['_value']) return true;
        else return false;
    }

    awaitInitialReplication(): Promise<true> {
        return this.initialReplicationComplete$.pipe(
            filter(v => v === true),
            first()
        ).toPromise();
    }

    // ensures this._run() does not run in parallel
    async run(retryOnFail = true): Promise<void> {
        if (this.isStopped()) {
            return;
        }

        if (this._runQueueCount > 2) {
            return this._runningPromise;
        }

        this._runQueueCount++;
        this._runningPromise = this._runningPromise.then(async () => {
            this._subjects.active.next(true);
            const willRetry = await this._run(retryOnFail);
            this._subjects.active.next(false);
            if (!willRetry && this._subjects.initialReplicationComplete['_value'] === false) {
                this._subjects.initialReplicationComplete.next(true);
            }
            this._runQueueCount--;
        });
        return this._runningPromise;
    }

    /**
     * returns true if retry must be done
     */
    async _run(retryOnFail = true): Promise<boolean> {
        this._runCount++;

        // Do push
        const pushOk = await this.runPush();
        if (!pushOk && retryOnFail) {
            setTimeout(() => this.run(), this.retryTime);
            /*
                Because we assume that conflicts are solved on the server side,
                if push failed, do not attempt to pull before push was successful
                otherwise we do not know how to merge changes with the local state
            */
            return true;
        }

        // Do pull
        const pullOk = await this.runPull();
        if (!pullOk && retryOnFail) {
            setTimeout(() => this.run(), this.retryTime);
            return true;
        }

        return false;
    }

    /**
     * @return true if sucessfull
     */
    async runPull(): Promise<boolean> {
        console.log('RxGitHubReplicationState.runPull(): start');
        if (this.isStopped()) return Promise.resolve(false);

        const timestampName = 'authoredDate';

        const latestDocument = await getLastPullDocument(this.collection, this.endpointHash);
        console.debug('--lastPullDocument');
        console.dir(latestDocument);
        const lastTime = latestDocument && latestDocument[timestampName] ? latestDocument[timestampName] : '1970-01-01T00:00:00Z';
        const sinceTime = (new Date(Date.parse(lastTime) + 1000)).toISOString().replace(/\..+?Z$/, 'Z');
        const historyOption = `since: "${sinceTime}"`;
        console.dir(historyOption);

        // Get list of documentIDs;
        const repos: any = await this.octokit.graphql(`
        {
            repository(owner: "${this.github.owner}", name: "${this.github.repository}") {
                defaultBranchRef {
                    target {
                        ... on Commit {
                            history(${historyOption}) {
                                nodes {
                                    oid
                                    ${timestampName}
                                }
                            }
                        }
                    }
                }
            }
        }
        `
        ).catch(err => {
            this._subjects.error.next(err);
            return false;
        });
        //        console.dir(repos);

        // Get commits sorted from new to old
        const commitList: { "oid": string, "authoredDate": string }[] = repos.repository.defaultBranchRef ? repos.repository.defaultBranchRef.target.history.nodes : [];
        // Reverse it to sort from old to new
        commitList.reverse();
        console.debug('-- commit list');
        console.dir(commitList);

        const shaDateMap = new Map();
        // Get list of document
        const getters: Promise<OctokitResponse<ReposGetCommitResponseData>>[] = [];

        commitList.forEach(commit => {
            const getter = (sha: string) =>
                // [getCommit API] https://github.com/octokit/plugin-rest-endpoint-methods.js/blob/5819d6ad02e18a31dbb50aab55d5d9411928ad3f/docs/repos/getCommit.md
                this.octokit.repos.getCommit({
                    owner: this.github.owner,
                    repo: this.github.repository,
                    ref: sha,
                });
            getters.push(getter(commit.oid));
        });
        const detailedCommits = await Promise.all(getters).catch(err => {
            this._subjects.error.next(err);
        });
        if (!detailedCommits) {
            // Error
            return false;
        }
        const dateAndDocs = detailedCommits.map(commit => {
            const patch = commit.data.files[0].patch;
            const res = patch.match(/^\+({.+})$/m);
            if (res) {
                const obj: any = {
                    doc: JSON.parse(res[1])
                };
                obj[timestampName] = commit.data.commit.author.date;
                return obj;
            }
            else {
                return ''
            }
        }).filter(dateAndDoc => dateAndDoc !== '');
        console.debug('-- dateAndDocs');
        console.dir(dateAndDocs);

        /*
        const docIds = dateAndDocs.map(dateAndDoc => dateAndDoc.doc.id);
        console.debug('-- docIDs');
        console.dir(docIds);

        const docsWithRevisions = await getDocsWithRevisionsFromPouch(
            this.collection,
            docIds
        );
        */
        /*
        await Promise.all(
            // Check revisions and deletedFlag
             dateAndDocs.map((dateAndDoc: any) => this.handleDocumentFromRemote(dateAndDoc.doc))
        );
        */
        // for loop is slower than Promise.all, but handle order of remote revisions correctly
        for(let dateAndDoc of dateAndDocs) await this.handleDocumentFromRemote(dateAndDoc.doc);

        dateAndDocs.map((dateAndDoc: any) => this._subjects.recieved.next(dateAndDoc.doc));

        if (dateAndDocs.length === 0) {
            if (this.live) {
                // console.log('no more docs, wait for ping');
            } else {
                // console.log('RxGitHubReplicationState._run(): no more docs and not live; complete = true');
            }
        } else {
            const newLatestDateAndDoc = dateAndDocs[dateAndDocs.length-1];
            const newLatestDocument = {
                ...newLatestDateAndDoc.doc
            };
            newLatestDocument[timestampName] = newLatestDateAndDoc[timestampName];

            await setLastPullDocument(
                this.collection,
                this.endpointHash,
                newLatestDocument
            );

            // we have more docs, re-run
            await this.runPull();
        }

        return true;
    }

    createOrUpdateGitHub = async (doc: any, isNew: boolean) => {
        let trialCount = 0;

        const getAndUpdateContent = async () => {
            trialCount++;
            console.debug('Trial: ' + trialCount);

            const updatedContent = JSON.stringify(doc);
            console.debug('[new content] ' + updatedContent);

            // [createOrUpdateFileContents API] https://github.com/octokit/plugin-rest-endpoint-methods.js/blob/5819d6ad02e18a31dbb50aab55d5d9411928ad3f/docs/repos/createOrUpdateFileContents.md
            const options: { owner: string; repo: string; path: string; sha?: string, message: string; content: string } = {
                owner: this.github.owner,
                repo: this.github.repository,
                path: doc.id,
                message: this.github.message,
                content: Buffer.from(updatedContent).toString('base64'),
            };

            /**
             * 1. Get SHA of blob by using id
             */
            let oldSHA: string;
            if (!isNew) {
                oldSHA = this.cacheOfGitHubContentSHA.get(doc.id);
                if (!oldSHA) {
                    const oldContentResult = await this.octokit.repos.getContent({
                        owner: this.github.owner,
                        repo: this.github.repository,
                        path: doc.id,
                    }).catch(err => {
                        return err;
                    });
                    oldSHA = oldContentResult.data.sha;

                    // const oldContent = Buffer.from(oldContentResult.data.content, oldContentResult.data.encoding as any).toString();
                    // console.debug('[old content] ' + oldContent);        
                }
                options['sha'] = oldSHA;

                console.log('old sha: ' + oldSHA);
            }
            /**
             * 2. Create of Update blob and Commit
             */
            const result = await this.octokit.repos.createOrUpdateFileContents(
                options
            ).catch(err => {
                return err;
            });

            console.debug('[update result]');
            console.dir(result);
            return result;
        };

        /**
         * 3. Retry to get SHA and commit if conflict
         */
        let updatedContentResult: OctokitResponse<ReposCreateOrUpdateFileContentsResponseData | ReposCreateOrUpdateFileContentsResponse201Data> | void;
        let retry = false;
        do {
            updatedContentResult = await getAndUpdateContent().catch(err => console.debug(err));
            retry = false;
            if (!updatedContentResult) {
                // Network error?
            }
            else if (updatedContentResult.status === 403) {
                if (updatedContentResult.headers["x-ratelimit-remaining"] && updatedContentResult.headers["x-ratelimit-remaining"] === '0') {
                    // Reach rate limit
                }
                /*            else if(){
                                // Abuse limit
                            } */
                else {
                    // Other

                }
            }
            else if (updatedContentResult.status === 409) {
                // HttpError: 409 Conflict
                // Remove cache to get SHA again
                this.cacheOfGitHubContentSHA.delete(doc.id);
                retry = true;
            }

            console.debug('retry: ' + retry);
        } while (retry);

        /**
         * 4. Cache SHA of new blob
         */
        if (updatedContentResult) {
            const updatedSHA = updatedContentResult.data.content.sha;
            console.debug('updated sha: ' + updatedSHA);

            // SHA should be cached to reduce API requests
            this.cacheOfGitHubContentSHA.set(doc.id, updatedSHA);
        }
    };
    /**
     * @return true if successfull, false if not
     */
    async runPush(): Promise<boolean> {
        console.log('RxGitHubReplicationState.runPush(): start');

        const changes = await getChangesSinceLastPushSequence(
            this.collection,
            this.endpointHash,
            this.lastPulledRevField,
            this.push.batchSize,
            this.syncRevisions
        );

        const changesWithDocs = await Promise.all(changes.results.map(async (change: any) => {
            let doc = change['doc'];

            doc[this.deletedFlag] = !!change['deleted'];
            delete doc._deleted;
            delete doc._attachments;
            delete doc[this.lastPulledRevField];

            let isNew = false;
            if (doc._rev.startsWith('1-')) {
                // New doc
                isNew = true;
            }
            if (!this.syncRevisions) {
                delete doc._rev;
            }

            doc = await (this.push as any).modifier(doc);

            const seq = change.seq;
            return {
                doc,
                seq,
                isNew,
            };
        }));

        let lastSuccessfullChange = null;
        try {
            /**
             * we cannot run all queries parallel
             * because then we would not know
             * where to start again on errors
             * so we run through the docs in series
             */
            for (let i = 0; i < changesWithDocs.length; i++) {
                const changeWithDoc = changesWithDocs[i];
                console.debug('isNew:' + changeWithDoc.isNew);
                try {
                    this.createOrUpdateGitHub(changeWithDoc.doc, changeWithDoc.isNew);
                } catch (err) {
                    throw new Error(err);
                }

                this._subjects.send.next(changeWithDoc.doc);
                lastSuccessfullChange = changeWithDoc;

            }
        } catch (err) {

            if (lastSuccessfullChange) {
                await setLastPushSequence(
                    this.collection,
                    this.endpointHash,
                    lastSuccessfullChange.seq
                );
            }
            this._subjects.error.next(err);
            return false;
        }

        // all docs where successfull, so we use the seq of the changes-fetch
        await setLastPushSequence(
            this.collection,
            this.endpointHash,
            changes.last_seq
        );

        if (changes.results.length === 0) {
            if (this.live) {
                // console.log('no more docs to push, wait for ping');
            } else {
                // console.log('RxGitHubReplicationState._runPull(): no more docs to push and not live; complete = true');
            }
        } else {
            // we have more docs, re-run
            await this.runPush();
        }

        return true;
    }

    async handleDocumentFromRemote(doc: any) {
        const deletedValue = doc[this.deletedFlag];
        const toPouch = this.collection._handleToPouch(doc);
        console.log('handleDocumentFromRemote(' + toPouch._id + ') start. deleledValue is ' + deletedValue);
        toPouch._deleted = deletedValue;
        delete toPouch[this.deletedFlag];

        const docsWithRevisions = await getDocsWithRevisionsFromPouch(
            this.collection, [toPouch._id]);

        if (!this.syncRevisions) {
            const primaryValue = toPouch._id;

            const pouchState = docsWithRevisions[primaryValue];
            let newRevision = createRevisionForPulledDocument(
                this.endpointHash,
                toPouch
            );
            if (pouchState) {
                console.dir(pouchState);
                const newRevisionHeight = pouchState.revisions.start + 1;
                const revisionId = newRevision;
                newRevision = newRevisionHeight + '-' + newRevision;
                toPouch._revisions = {
                    start: newRevisionHeight,
                    ids: pouchState.revisions.ids
                };
                toPouch._revisions.ids.unshift(revisionId);
            } else {
                console.debug('no pouchState');
                newRevision = '1-' + newRevision;
            }

            toPouch._rev = newRevision;
        } else {
            toPouch[this.lastPulledRevField] = toPouch._rev;
        }

        const startTime = now();
        await this.collection.pouch.bulkDocs(
            [
                toPouch
            ], {
            new_edits: false
        });
        const endTime = now();

        /**
         * because bulkDocs with new_edits: false
         * does not stream changes to the pouchdb,
         * we create the event and emit it,
         * so other instances get informed about it
         */
        const originalDoc = flatClone(toPouch);

        if (deletedValue) {
            originalDoc._deleted = deletedValue;
        } else {
            delete originalDoc._deleted;
        }
        delete originalDoc[this.deletedFlag];
        delete originalDoc._revisions;

        const cE = changeEventfromPouchChange(
            originalDoc,
            this.collection,
            startTime,
            endTime
        );
        this.collection.$emit(cE);
    }

    cancel(): Promise<any> {
        if (this.isStopped()) return Promise.resolve(false);
        this._subs.forEach(sub => sub.unsubscribe());
        this._subjects.canceled.next(true);
        return Promise.resolve(true);
    }

    setHeaders(headers: { [k: string]: string }): void {
        this.client = GraphQLClient({
            url: this.url,
            headers
        });
    }
}

export function syncGraphQL(
    this: RxCollection,
    {
        url,
        headers = {},
        waitForLeadership = true,
        github,
        pull,
        push,
        deletedFlag,
        lastPulledRevField = 'last_pulled_rev',
        live = false,
        liveInterval = 1000 * 10, // in ms
        retryTime = 1000 * 5, // in ms
        autoStart = true, // if this is false, the replication does nothing at start
        syncRevisions = false,
    }: any
) {
    const collection = this;

    // fill in defaults for pull & push
    if (!github.modifier) github.modifier = DEFAULT_MODIFIER;
    if (!push.modifier) push.modifier = DEFAULT_MODIFIER;

    // ensure the collection is listening to plain-pouchdb writes
    collection.watchForChanges();

    const replicationState = new RxGitHubReplicationState(
        collection,
        url,
        headers,
        github,
        push,
        deletedFlag,
        lastPulledRevField,
        live,
        liveInterval,
        retryTime,
        syncRevisions
    );

    if (!autoStart) return replicationState;

    // run internal so .sync() does not have to be async
    const waitTillRun: any = waitForLeadership ? this.database.waitForLeadership() : promiseWait(0);
    waitTillRun.then(() => {

        // trigger run once
        replicationState.run();

        // start sync-interval
        if (replicationState.live) {

            (async () => {
                while (!replicationState.isStopped()) {
                    await promiseWait(replicationState.liveInterval);
                    if (replicationState.isStopped()) return;
                    await replicationState.run(
                        // do not retry on liveInterval-runs because they might stack up
                        // when failing
                        false
                    );
                }
            })();


            /**
             * we have to use the rxdb changestream
             * because the pouchdb.changes stream sometimes
             * does not emit events or stucks
             */
            const changeEventsSub = collection.$.subscribe(changeEvent => {
                if (replicationState.isStopped()) return;
                const rev = changeEvent.documentData._rev;
                if (
                    rev &&
                    !wasRevisionfromPullReplication(
                        replicationState.endpointHash,
                        rev
                    )
                ) {
                    replicationState.run();
                }
            });
            replicationState._subs.push(changeEventsSub);

        }
    });

    return replicationState;
}

export * from './helper';
export * from './crawling-checkpoint';
export * from './graphql-schema-from-rx-schema';
export * from './query-builder-from-rx-schema';

export const rxdb = true;
export const prototypes = {
    RxCollection: (proto: any) => {
        proto.syncGraphQL = syncGraphQL;
    }
};

export const RxDBReplicationGitHubPlugin: RxPlugin = {
    rxdb,
    prototypes
};
