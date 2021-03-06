/*
 * e-app lifecycle:
 *
 *      commands                  e-app                   worker                    sub-workers
 *          |                       |                       |                           |
 * <--- e-app::ready -------------- |                       |                           |
 *          |                       |                       |                           |
 *      e-app:>create-worker        |                       |                           |
 *          |----------------> createWorker                 |                           |
 *          |                       |---------------------> |                           |
 *          |                       | <- did-finish-load -- |                           |
 *          |                       | -- wrk:>init--------> |                           |
 *          |                       |              createSubworkers                     |
 *          |                       |                       | -- -- -- -- -- -- -- -- > |[creating]
 *          |                       |                       |                           |   *
 *          |                       |                       |                           |[creating]
 *          |                       |                       | <-- -- wrk::created -- -- |[empty]
 *          |                       | <--- wrk::created --- |                           |   *
 * <--- e-app::wrk-state[empty] --- |                       |                           |   *
 *          |                       |                       |                           |   *
 *      e-app:>fill-worker          |                       |                           |   *
 *          |-----------------> fillWorker                  |                           |   *
 *          |                       | -- wrk:>fill -------> |                           |   *
 *          |                       |                   fillSubworker                   |[empty]
 *          |                       |                       | -- -- -- -- -- -- -- -- > |[filling]
 *          |                       |                       |                           |   *
 *          |                       |                       |                           |[filling]
 *          |                       |                       | < -- -- wrk::filled -- -- |[ready]
 *          |                       | <--- wrk::filled ---- |                           |   *
 * <--- e-app::wrk-state[ready] --- |                       |                           |   *
 *          |                       |                       |                           |   *
 *      e-app:>exec                 |                       |                           |   *
 *          |--------------------> exec                     |                           |   *
 *          |                       | -- wrk:>exec -------> |                           |   *
 *          |                       |                      exec                         |[ready]
 *          |                       |                       | -- -- -- -- -- -- -- -- > |[busy]
 *          |                       |                       |                           |   *
 *          |                       |                       |                           |[busy]
 *          |                       |                       | <- -- -- wrk::done  -- -- |[dirty]
 *          |                       | <--- wrk::done ------ |                           |   *
 * <--- e-app::done --------------- |                       |                           |   *
 *          |                       |                       |                           |[dirty]
 *
 *
 *
 * # Worker reload:
 *
 *      e-app:>reload-worker        |                       |                           |   *
 *          |----------------> reloadWorker                 |                           |   *
 *          |                       |---------------------> |                           |   *
 *          |                       |           OR          |                           |   *
 *          |                       | -- wrk:>reload -----> |                           |   *
 *          |                       |                     reload                        |   *
 *          |                       |                       | -- -- -- -- -- -- -- -- > |[creating]
 *          |                       |                       |                           |   *
 *          |                       |                       |                           |[creating]
 *          |                       |                       | <-- -- wrk::created -- -- |[empty]
 *          |                       | <--- wrk::created --- |                           |   *
 * <--- e-app::wrk-state[empty] --- |                       |                           |   *
 */

const path = require('path');
const url = require('url');

const { app, BrowserWindow, ipcMain } = require('electron');

const eAppLogger = require('./e-app-logger');

const INTERNAL_WORKER_STATE = {
    creating: 'creating',
    empty: 'empty',
    filling: 'filling',
    ready: 'ready',
    busy: 'busy',
    dirty: 'dirty',
};
const INCOMING_COMMANDS = {
    createWorker: 'e-app:>create-worker',
    fillWorker: 'e-app:>fill-worker',
    reloadWorker: 'e-app:>reload-worker',
    exec: 'e-app:>exec',
    flush: 'e-app:>flush',
    destroy: 'e-app:>destroy',
};
const INCOMING_WORKER_EVENTS = {
    created: 'wrk::created',
    filled: 'wrk::filled',
    done: 'wrk::done',
};
const OUTCOMING_WORKER_COMMANDS = {
    init: 'wrk:>init',
    fill: 'wrk:>fill',
    exec: 'wrk:>exec',
    reload: 'wrk:>reload',
};
const OUTCOMING_EVENTS = {
    ready: 'e-app::ready',
    workerState: 'e-app::wrk-state',
    done: 'e-app::done',
};

const args = JSON.parse(process.argv[2]);
const { error, perf, flush } = eAppLogger(args.logLevel);

function destroy() {
    app.exit(0);

    process.exit(0);
}

function buildSandUrl(sand) {
    return url.format({
        protocol: 'file',
        slashes: true,
        pathname: path.join(__dirname, 'sand', `${sand}.html`),
    });
}

function createWorker(options) {
    const win = new BrowserWindow(
        Object.assign(
            {
                webPreferences: {
                    nodeIntegration: false,
                    nodeIntegrationInWorker: false,
                    contextIsolation: true,
                    preload: path.join(__dirname, 'preload.js'),
                },
            },
            args.browserWindow
        )
    );
    const webContents = win.webContents;

    if (args.showDevTools && args.browserWindow.show) {
        webContents.openDevTools();
    }

    webContents.on('did-finish-load', () => {
        webContents.send('message', {
            type: OUTCOMING_WORKER_COMMANDS.init,
            payload: options,
        });
    });

    webContents.loadURL(buildSandUrl(args.sand), args.urlOptions);
}

function fillWorker({ path, content, fillerId, options }) {
    const workerId = path.shift();
    const win = BrowserWindow.fromId(workerId);
    const webContents = win.webContents;

    webContents.send('message', {
        type: OUTCOMING_WORKER_COMMANDS.fill,
        payload: { path, fillerId, content, options },
    });
}

function reloadWorker({ path }) {
    const workerId = path.shift();
    const win = BrowserWindow.fromId(workerId);
    const webContents = win.webContents;

    if (path.length !== 0) {
        // path is not empty => subworkers are used => it is up to subworkers
        //      to decide how to reload their subworkers
        return webContents.send('message', {
            type: OUTCOMING_WORKER_COMMANDS.reload,
            payload: { path },
        });
    }

    webContents.loadURL(buildSandUrl(args.sand), args.urlOptions);
}

function exec(payload) {
    // performance critical function; make it FTL;
    const win = BrowserWindow.fromId(payload.path.shift());

    win.webContents.send('message', {
        type: OUTCOMING_WORKER_COMMANDS.exec,
        payload,
    });
}

process.on('message', ({ type, payload }) => {
    perf('onHostMessage type:', type);

    switch (type) {
        case INCOMING_COMMANDS.createWorker:
            return createWorker(payload);
        case INCOMING_COMMANDS.fillWorker:
            return fillWorker(payload);
        case INCOMING_COMMANDS.reloadWorker:
            return reloadWorker(payload);
        case INCOMING_COMMANDS.exec:
            return exec(payload);
        case INCOMING_COMMANDS.flush:
            return flush();
        case INCOMING_COMMANDS.destroy:
            return destroy();
        default:
            error('unknown message:', type);
    }
});

ipcMain
    .on(INCOMING_WORKER_EVENTS.created, (event, message) => {
        if (!message) {
            return error(INCOMING_WORKER_EVENTS.created, 'no message');
        }

        const win = BrowserWindow.fromWebContents(event.sender);
        const workerId = win.id;

        process.send({
            type: OUTCOMING_EVENTS.workerState,
            payload: {
                state: INTERNAL_WORKER_STATE.empty,
                path: [workerId].concat(message.path),
            },
        });
    })
    .on(INCOMING_WORKER_EVENTS.filled, (event, message) => {
        if (!message) {
            return error(INCOMING_WORKER_EVENTS.filled, 'no message');
        }

        const win = BrowserWindow.fromWebContents(event.sender);
        const workerId = win.id;

        process.send({
            type: OUTCOMING_EVENTS.workerState,
            payload: {
                state: INTERNAL_WORKER_STATE.ready,
                path: [workerId].concat(message.path),
                fillerId: message.fillerId,
            },
        });
    })
    .on(INCOMING_WORKER_EVENTS.done, (event, message) => {
        if (!message) {
            return error(INCOMING_WORKER_EVENTS.done, 'no message');
        }

        const win = BrowserWindow.fromWebContents(event.sender);
        const workerId = win.id;

        message.path = [workerId].concat(message.path);

        process.send({
            type: OUTCOMING_EVENTS.done,
            payload: message,
        });
    });

app.on('ready', () => {
    perf('e-app electron ready');
    process.send({ type: OUTCOMING_EVENTS.ready, payload: {} });
});

perf('e-app loaded');
