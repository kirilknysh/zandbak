const EventEmitter = require('events');

const contract = require('../contract');

const TYPE = 'firefox';

module.exports = function firefox(options, logger) {
    const emitter = new EventEmitter();
    const instance = contract.instance(TYPE, emitter);

    return instance;
};
