/**
 * State
 */
var _ = require('lodash');
var m = require('mithril');
var defaultKey = '__key__';
var privateKeys = ['factory', 'toJson', '_options'];

function _toJson() {
	var json = {};
	for (var prop in this) {
		if (_.indexOf(privateKeys, prop) === -1) {
			json[prop] = this[prop]();
		}
	}
	return json;
}

function createState(signature, state, options, factoryKey) {
	var propVal;
	state._options = _.assign({
		store: m.prop
	}, options);
	for (var prop in signature) {
		if (_.indexOf(privateKeys, prop) > -1)
			throw new Error('State key `' + prop + '` is not allowed.');
		propVal = signature[prop];
		state[prop] = _.isFunction(propVal) ? propVal : state._options.store(propVal, prop, factoryKey);
	}
	return state;
}

// Class
function State(signature, options) {
	if (_.isArray(signature)) {
		this.signature = _.invert(signature);
		for (var prop in this.signature) {
			this.signature[prop] = undefined;
		}
	} else {
		this.signature = signature;
	}
	this._options = options;
	this.map = {};
}

// Exports
module.exports = State;

// Single state
State.create = function(signature, options) {
	return createState(signature, {
		toJson: _toJson
	}, options);
};

// Prototype
State.prototype = {
	set: function(key) {
		if (!key)
			key = defaultKey;
		if (!this.map[key]) {
			this.map[key] = createState(this.signature, {
				factory: m.prop(this),
				toJson: _toJson
			}, this._options, key);
		}
		return this.map[key];
	},
	get: function(key) {
		if (!key)
			key = defaultKey;
		if (!this.map[key]) {
			this.set(key);
		}
		return this.map[key];
	},
	remove: function(key) {
		if (!key)
			key = defaultKey;
		if (this.map[key]) {
			var b, keys = _.keys(this.map[key]);
			for (b = 0; b < keys.length; b++) {
				this.map[key][keys[b]] = null;
			}
			delete this.map[key];
		}
	},
	dispose: function() {
		var keysThis = _.keys(this);
		var keysMap = _.keys(this.map);
		var keySignature = _.keys(this.signature);
		var a, b;
		for (a = 0; a < keysMap.length; a++) {
			for (b = 0; b < keySignature.length; b++) {
				this.map[keysMap[a]][keySignature[b]] = null;
			}
			this.map[keysMap[a]] = null;
		}
		for (a = 0; a < keysThis.length; a++) {
			this[keysThis[a]] = null;
		}
	}
};