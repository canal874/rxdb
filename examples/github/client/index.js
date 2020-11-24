import './style.css';
import config from '../config.json';

import {
    addRxPlugin,
    createRxDatabase
} from 'rxdb/plugins/core';

addRxPlugin(require('pouchdb-adapter-idb'));
import {
    RxDBReplicationGitHubPlugin,
} from 'rxdb/plugins/replication-github';
addRxPlugin(RxDBReplicationGitHubPlugin);


// TODO import these only in non-production build
import { RxDBDevModePlugin } from 'rxdb/plugins/dev-mode';
addRxPlugin(RxDBDevModePlugin);
import { RxDBValidatePlugin } from 'rxdb/plugins/validate';
addRxPlugin(RxDBValidatePlugin);

import { RxDBUpdatePlugin } from 'rxdb/plugins/update';
addRxPlugin(RxDBUpdatePlugin);

import { RxDBQueryBuilderPlugin } from 'rxdb/plugins/query-builder';
addRxPlugin(RxDBQueryBuilderPlugin);

import {
    GRAPHQL_PORT,
    GRAPHQL_PATH,
    heroSchema,
} from '../shared';

const insertButton = document.querySelector('#insert-button');
const heroesList = document.querySelector('#heroes-list');
const leaderIcon = document.querySelector('#leader-icon');

console.log('hostname: ' + window.location.hostname);
const syncURL = 'http://' + window.location.hostname + ':' + GRAPHQL_PORT + GRAPHQL_PATH;


const batchSize = 5;

/**
 * In the e2e-test we get the database-name from the get-parameter
 * In normal mode, the database name is 'heroesdb'
 */
function getDatabaseName() {
    const url_string = window.location.href;
    const url = new URL(url_string);
    const dbNameFromUrl = url.searchParams.get('database');

    let ret = 'heroesdb';
    if (dbNameFromUrl) {
        console.log('databaseName from url: ' + dbNameFromUrl);
        ret += dbNameFromUrl;
    }
    return ret;
}

async function run() {
    heroesList.innerHTML = 'Create database..';
    const db = await createRxDatabase({
        name: getDatabaseName(),
        adapter: 'idb'
    });
    window.db = db;

    // display crown when tab is leader
    db.waitForLeadership().then(function () {
        document.title = '♛ ' + document.title;
        leaderIcon.style.display = 'block';
    });

    heroesList.innerHTML = 'Create collection..';
    const collection = await db.collection({
        name: 'hero',
        schema: heroSchema
    });

    console.dir(config);

    // set up replication
    heroesList.innerHTML = 'Start replication..';
    const replicationState = collection.syncGraphQL({
        url: syncURL,
        push: {
            batchSize,
        },
        github: {
            owner: config.owner,
            repository: config.repository,
            auth: config.auth,
            message: config.message,
        },
        live: true,
        /**
         * Because the websocket is used to inform the client
         * when something has changed,
         * we can set the liveIntervall to a high value
         */
        liveInterval: 1000 * 60 * 10, // 10 minutes
        deletedFlag: 'deleted'
    });
    // show replication-errors in logs
    heroesList.innerHTML = 'Subscribe to errors..';
    replicationState.error$.subscribe(err => {
        console.error('replication error:');
        console.dir(err);
    });

    /**
     * We await the inital replication
     * so that the client never shows outdated data.
     * You should not do this if you want to have an
     * offline-first client, because the inital sync
     * will not run through without a connection to the
     * server.
     */

    heroesList.innerHTML = 'Await initial replication..';
    await replicationState.awaitInitialReplication();

    // Pull from GitHub periodically
    setInterval(() => {
        replicationState.run();
    }, 1000 * 60 );

    // subscribe to heroes list and render the list on change
    heroesList.innerHTML = 'Subscribe to query..';
    collection.find()
        .sort({
            name: 'asc'
        })
        .$.subscribe(function (heroes) {
            let html = '';
            heroes.forEach(function (hero) {
                html += `
                    <li class="hero-item">
                        <div class="color-box" style="background:${hero.color}"></div>
                        <div class="name">${hero.name}</div>
                        <div class="delete-icon" onclick="window.deleteHero('${hero.primary}')">DELETE</div>
                    </li>
                `;
            });
            heroesList.innerHTML = html;
        });


    // set up click handlers
    window.deleteHero = async (id) => {
        console.log('delete doc ' + id);
        const doc = await collection.findOne(id).exec();
        if (doc) {
            console.log('got doc, remove it');
            try {
                await doc.remove();
            } catch (err) {
                console.error('could not remove doc');
                console.dir(err);
            }
        }
    };
    insertButton.onclick = async function () {
        const name = document.querySelector('input[name="name"]').value;
        const color = document.querySelector('input[name="color"]').value;
        const obj = {
            id: name,
            name: name,
            color: color,
        };
        console.log('inserting hero:');
        console.dir(obj);

        await collection.insert(obj);
        document.querySelector('input[name="name"]').value = '';
        document.querySelector('input[name="color"]').value = '';
    };
}
run().catch(err => {
    console.log('run() threw an error:');
    console.error(err);
});
