/**
 * Base Model
 */

var _ = require('lodash');
var m = require('mithril');
var stream = require('mithril/stream');
var config = require('./global').config;
var modelConstructors = require('./global').modelConstructors;

function BaseModel(opts) {
	this.__options = {
		redraw: false,
		parse: true
	};
	this.__collections = [];
	this.__lid = _.uniqueId('model');
	this.__saved = false;
	this.__json = {
		__model: this
	};
	_.bindAll(this, _.union(modelBindMethods, config.modelBindMethods));
	if (opts)
		this.opt(opts);
}

// Export class.
module.exports = BaseModel;

// Need to require after export. To fix the circular dependencies issue.
var store = require('./store');
var util = require('./util');
var Collection = require('./collection');

// Method to bind to Model object. Use by _.bindAll().
var modelBindMethods = [];

// Lodash methods to add.
var objectMethods = {
	has: 1,
	keys: 0,
	values: 0,
	pick: 1,
	omit: 1
};

// Prototype methods.
BaseModel.prototype = {
	opt: function(key, value) {
		if (_.isPlainObject(key))
			_.assign(this.__options, key);
		else
			this.__options[key] = _.isUndefined(value) ? true : value;
	},
	// Get or set id of model.
	id: function(id) {
		return id ? this[config.keyId](id, true) : this[config.keyId]();
	},
	lid: function() {
		return this.__lid;
	},
	// Get the full url for store.
	url: function() {
		return config.baseUrl + (this.options.url || '/' + this.options.name.toLowerCase());
	},
	// Add this model to collection.
	attachCollection: function(collection) {
		if (!(collection instanceof Collection))
			throw new Error('Argument `collection` must be instance of Collection.');
		var model = collection.get(this);
		if (model && _.indexOf(this.__collections, collection) === -1) {
			// This model exist in collection.
			// Add collection to model's local reference.
			this.__collections.push(collection);
		} else {
			collection.add(this);
		}
	},
	// Remove this model from collection.
	detachCollection: function(collection) {
		if (!(collection instanceof Collection))
			throw new Error('Argument `collection` must be instance of Collection.');
		// Remove this model from collection first.
		if (collection.get(this)) {
			collection.remove(this);
		}
		// Remove that collection from model's collection.
		if (_.indexOf(this.__collections, collection) > -1)
			_.pull(this.__collections, collection);
	},
	// Sets all or a prop values from passed data.
	set: function(key, value, silent) {
		if (_.isString(key)) {
			this[key](value, silent);
		} else {
			this.setObject(key, silent);
		}
	},
	// Sets props by object.
	setObject: function(obj, silent) {
		var isModel = obj instanceof BaseModel;
		if (!isModel && !_.isPlainObject(obj))
			throw new Error('Argument `obj` must be a model or plain object.');
		var _obj = (!isModel && this.__options.parse) ? this.options.parser(obj) : obj;
		var keys = _.keys(_obj);
		for (var i = keys.length - 1, key, val; i >= 0; i--) {
			key = keys[i];
			val = _obj[key];
			if (!this.__isProp(key) || !_.isFunction(this[key]))
				continue;
			if (isModel && _.isFunction(val)) {
				this[key](val(), true);
			} else {
				this[key](val, true);
			}
		}
		if (!silent) // silent
			this.__update();
	},
	// Get all or a prop values in object format. Creates a copy.
	get: function(key) {
		if (key)
			return this[key]();
		else
			return this.getCopy();
	},
	// Retrieve json representation. Including private properties.
	getJson: function() {
		return this.__json;
	},
	// Get a copy of json representation. Removing private properties.
	getCopy: function(deep) {
		var copy = {};
		var keys = _.keys(this.__json);
		for (var i = 0, key, value; i < keys.length; i++) {
			key = keys[i];
			value = this.__json[key];
			if (this.__isProp(key)) {
				if (value && value.__model instanceof BaseModel)
					copy[key] = value.__model.get();
				else
					copy[key] = value;
			}
		}
		return deep ? _.cloneDeep(copy) : copy;
	},
	save: function(options, callback) {
		if (_.isFunction(options)) {
			callback = options;
			options = undefined;
		}
		var self = this;
		return new Promise(function(resolve, reject) {
			var req = self.id() ? store.put : store.post;
			req.call(store, self.url(), self, options).then(function(data) {
				self.set(options && options.path ? _.get(data, options.path) : data);
				self.__saved = true;
				resolve(self);
				if (_.isFunction(callback)) callback(null, data, self);
			}, function(err) {
				reject(err);
				if (_.isFunction(callback)) callback(err);
			});
		});
	},
	fetch: function(options, callback) {
		if (_.isFunction(options)) {
			callback = options;
			options = undefined;
		}
		var self = this;
		return new Promise(function(resolve, reject) {
			var id = self.__getDataId();
			if (id[config.keyId]) {
				store.get(self.url(), id, options).then(function(data) {
					self.set(options && options.path ? _.get(data, options.path) : data);
					self.__saved = true;
					resolve(self);
					if (_.isFunction(callback)) callback(null, data, self);
				}, function(err) {
					reject(err);
					if (_.isFunction(callback)) callback(err);
				});
			} else {
				reject(true);
				if (_.isFunction(callback)) callback(true);
			}
		});
	},
	populate: function(options, callback) {
		if (_.isFunction(options)) {
			callback = options;
			options = undefined;
		}
		var self = this;
		return new Promise(function(resolve, reject) {
			var refs = self.options.refs;
			var error;
			var countFetch = 0;
			_.forEach(refs, function(refName, refKey) {
				var value = self.__json[refKey];
				if (_.isString(value) || _.isNumber(value)) {
					var data = {};
					data[config.keyId] = value;
					var model = modelConstructors[refName].create(data);
					if (model.isSaved()) {
						// Ok to link reference
						self[refKey](model);
					} else {
						// Fetch and link
						countFetch++;
						model.fetch(
							(options && options.fetchOptions && options.fetchOptions[refKey] ? options.fetchOptions[refKey] : null),
							function(err, data, mdl) {
								countFetch--;
								if (err) {
									error = err;
								} else {
									self[refKey](mdl);
								}
								if (!countFetch) {
									if (error) {
										reject(error);
										if (_.isFunction(callback)) callback(null, error);
									} else {
										// All fetched
										resolve(self);
										if (_.isFunction(callback)) callback(null, self);
									}
								}
							}
						);
					}
				}
			});
			if (!countFetch) {
				resolve(self);
				if (_.isFunction(callback)) callback(null, self);
			}
		});
	},
	destroy: function(options, callback) {
		if (_.isFunction(options)) {
			callback = options;
			options = undefined;
		}
		// Destroy the model. Will sync to store.
		var self = this;
		return new Promise(function(resolve, reject) {
			var id = self.__getDataId();
			if (id[config.keyId]) {
				store.destroy(self.url(), id, options).then(function() {
					self.detach();
					resolve();
					if (_.isFunction(callback)) callback(null);
					self.dispose();
				}, function(err) {
					reject(err);
					if (_.isFunction(callback)) callback(err);
				});
			} else {
				reject(true);
				if (_.isFunction(callback)) callback(true);
			}
		});
	},
	remove: function() {
		this.detach();
		this.dispose();
	},
	detach: function() {
		// Detach this model to all collection.
		var clonedCollections = _.clone(this.__collections);
		for (var i = 0; i < clonedCollections.length; i++) {
			clonedCollections[i].remove(this);
			clonedCollections[i] = null;
		}
	},
	dispose: function() {
		var keys = _.keys(this);
		var props = this.options.props;
		var i;
		this.__json.__model = null;
		for (i = 0; i < props.length; i++) {
			this[props[i]](null);
		}
		for (i = 0; i < keys.length; i++) {
			this[keys[i]] = null;
		}
	},
	isSaved: function() {
		return this.__saved;
	},
	isNew: function() {
		return !(this.id() && this.__saved);
	},
	__update: function() {
		// Redraw by self.
		// var redrawing;
		// Levels: instance || schema || global
		// if (this.__options.redraw || this.options.redraw || config.redraw) {
		// 	m.startComputation();
		// 	redrawing = true;
		// }
		// Propagate change to model's collections.
		for (var i = 0; i < this.__collections.length; i++) {
			this.__collections[i].__update(this);
		}
		// if (redrawing)
		// 	util.nextTick(m.endComputation);
		if (this.__options.redraw || this.options.redraw || config.redraw) {
			m.redraw();
		}
	},
	__isProp: function(key) {
		return _.indexOf(this.options.props, key) > -1;
	},
	__getDataId: function() {
		var dataId = {};
		dataId[config.keyId] = this.id();
		return dataId;
	},
	__gettersetter: function(initial, key) {
		var _stream = stream();
		// Wrapper
		function prop() {
			var value;
			if (arguments.length) {
				// Write
				value = arguments[0];
				var ref = this.options.refs[key];
				if (ref) {
					var refConstructor = modelConstructors[ref];
					if (_.isPlainObject(value)) {
						value = refConstructor.create(value);
					} else if ((_.isString(value) || _.isNumber(value)) && refConstructor.__cacheCollection) {
						// Try to find the model in the cache
						value = refConstructor.__cacheCollection.get(value) || value;
					}
				}
				if (value instanceof BaseModel) {
					value = value.getJson();
				}
				_stream(value);
				this.__json[key] = _stream._state.value;
				if (!arguments[1])
					this.__update(key);
				return value;
			}
			value = _stream();
			if (value && value.__model instanceof BaseModel) {
				value = value.__model;
			} else if (_.isNil(value) && this.options && !_.isNil(this.options.defaults[key])) {
				// If value is null or undefined and a default value exist.
				// Return that default value which was set in schema.
				value = this.options.defaults[key];
			}
			return value;
		}
		prop.stream = _stream;
		prop.call(this, initial, true);
		return prop;
	},
	__gettersetter__: function(initial, key) {
		var store = this.__json;
		var ref = this.options.refs[key];
		// Getter and setter function.
		function prop() {
			var value;
			if (arguments.length) {
				// 0 = value
				// 1 = silent
				value = arguments[0];
				if (ref) {
					var refConstructor = modelConstructors[ref];
					if (_.isPlainObject(value)) {
						value = refConstructor.create(value);
					} else if ((_.isString(value) || _.isNumber(value)) && refConstructor.__cacheCollection) {
						// Try to find the model in the cache
						value = refConstructor.__cacheCollection.get(value) || value;
					}
				}
				if (value instanceof BaseModel) {
					value = value.getJson();
				}
				store[key] = value;
				if (!arguments[1])
					this.__update(key);
				return value;
			}
			value = store[key];
			if (value && value.__model instanceof BaseModel) {
				value = value.__model;
			} else if (_.isNil(value) && this.options && !_.isNil(this.options.defaults[key])) {
				// If value is null or undefined and a default value exist.
				// Return that default value which was set in schema.
				value = this.options.defaults[key];
			}

			return value;
		}
		// Add toJSON method to prop.
		prop.toJSON = function() {
			return store[key];
		};
		// Store initial value.
		prop(initial, true);
		return prop;
	}
};

// Inject lodash methods.
util.addMethods(BaseModel.prototype, _, objectMethods, '__json');