export interface GitHubSyncPullOptions {
    owner: string,
    repository: string,
    auth: string,
}

export interface GitHubSyncPushOptions {
    owner: string,
    repository: string,
    auth: string,
}

export type SyncOptionsGitHub = {
    url: string;
    headers?: { [k: string]: string }; // send with all requests to the endpoint
    waitForLeadership?: boolean; // default=true
    pull?: GitHubSyncPullOptions;
    push?: GitHubSyncPushOptions;
    deletedFlag: string;
    live?: boolean; // default=false
    liveInterval?: number; // time in ms
    retryTime?: number; // time in ms
    autoStart?: boolean; // if this is false, the replication does nothing at start
    syncRevisions?: boolean;
};
