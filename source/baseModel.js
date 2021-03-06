/**
 * Base Model
 */

var _ = require('lodash');
var m = require('mithril');
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
    this.__modified = false;
    this.__working = 0; // 0:idle, 1: fetch, 2: save, 3: destroy
    this.__json = {
        __model: this
    };
    _.bindAll(this, _.union(modelBindMethods, config.modelBindMethods));
    if (opts) this.opt(opts);
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
        if (_.isPlainObject(key)) _.assign(this.__options, key);
        else this.__options[key] = _.isUndefined(value) ? true : value;
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
        if (collection.get(this)) collection.remove(this);
        // Remove that collection from model's collection.
        if (_.indexOf(this.__collections, collection) > -1)
            _.pull(this.__collections, collection);
    },
    // Sets all or a prop values from passed data.
    set: function(key, value, silent, saved) {
        if (_.isString(key)) this[key](value, silent);
        else this.setObject(key, silent, saved);
    },
    // Sets props by object.
    setObject: function(obj, silent, saved) {
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
                this[key](val(), true, saved);
            } else {
                this[key](val, true, saved);
            }
        }
        if (!silent) // silent
            this.__update();
    },
    // Get all or a prop values in object format. Creates a copy.
    get: function(key) {
        return key ? this[key]() : this.getCopy();
    },
    // Retrieve json representation. Including private properties.
    getJson: function() {
        return this.__json;
    },
    // Get a copy of json representation. Removing private properties.
    getCopy: function(deep, depopulate) {
        var copy = {};
        var keys = _.keys(this.__json);
        for (var i = 0, key, value; i < keys.length; i++) {
            key = keys[i];
            value = this.__json[key];
            if (this.__isProp(key)) {
                if (value && value.__model instanceof BaseModel)
                    copy[key] = depopulate ? value.__model.id() : value.__model.getCopy(deep, true);
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
        var req = this.id() ? store.put : store.post;
        this.__working = 2;
        return req.call(store, this.url(), this, options).then(function(data) {
            self.set(options && options.path ? _.get(data, options.path) : data, null, null, true);
            self.__saved = !!self.id();
            // Add to cache, if enabled
            self.__addToCache();
            self.__working = 0;
            if (_.isFunction(callback)) callback(null, data, self);
            return self;
        }, function(err) {
            self.__working = 0;
            if (_.isFunction(callback)) callback(err);
            throw err;
        });
    },
    fetch: function(options, callback) {
        if (_.isFunction(options)) {
            callback = options;
            options = undefined;
        }
        this.__working = 1;
        var self = this,
            data = this.__getDataId(),
            id = _.trim(data[config.keyId]);
        if (id && id != 'undefined' && id != 'null') {
            return store.get(this.url(), data, options).then(function(data) {
                if (data) {
                    self.set(options && options.path ? _.get(data, options.path) : data, null, null, true);
                    self.__saved = !!self.id();
                } else {
                    self.__saved = false;
                }
                self.__working = 0;
                self.__addToCache();
                if (_.isFunction(callback)) callback(null, data, self);
                return self;
            }, function(err) {
                self.__working = 0;
                if (_.isFunction(callback)) callback(err);
                throw err;
            });
        } else {
            this.__working = 0;
            var err = new Error('Model must have an id to fetch')
            if (_.isFunction(callback)) callback(err);
            return Promise.reject(err);
        }
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
                        ).catch(reject);
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
        var data = this.__getDataId(),
            id = _.trim(data[config.keyId]);
        this.__working = 3;
        if (id && id != 'undefined' && id != 'null') {
            return store.destroy(this.url(), data, options).then(function() {
                self.detach();
                self.__working = 0;
                if (_.isFunction(callback)) callback(null);
                self.dispose();
            }, function(err) {
                self.__working = 0;
                if (_.isFunction(callback)) callback(err);
                throw err;
            });
        } else {
            var err = new Error('Model must have an id to destroy');
            this.__working = 0;
            if (_.isFunction(callback)) callback(err);
            return Promise.reject(err);
        }
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
        // Fresh from store
        return this.__saved;
    },
    isNew: function() {
        return !this.__saved;
    },
    isModified: function() {
        // When a prop is modified
        return this.__modified;
    },
    isDirty: function() {
        return !this.isSaved() || this.isModified();
    },
    isWorking: function() {
        return this.__working > 0;
    },
    isFetching: function() {
        return this.__working === 1;
    },
    isSaving: function() {
        return this.__working === 2;
    },
    isDestroying: function() {
        return this.__working === 3;
    },
    __update: function() {
        var redraw;
        // Propagate change to model's collections.
        for (var i = 0; i < this.__collections.length; i++) {
            if (this.__collections[i].__update(true)) {
                redraw = true;
            }
        }
        // Levels: instance || schema || global
        if (redraw || this.__options.redraw || this.options.redraw || config.redraw) {
            // console.log('Redraw', 'Model');
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
    __addToCache: function() {
        if (this.constructor.__options.cache && !this.constructor.__cacheCollection.contains(this) && this.__saved) {
            this.constructor.__cacheCollection.add(this);
        }
    },
    __gettersetter: function(initial, key) {
        var _stream = config.stream();
        var self = this;
        // Wrapper
        function prop() {
            var value, defaultVal;
            // arguments[0] is value
            // arguments[1] is silent
            // arguments[2] is saved (from store)
            // arguments[3] is isinitial
            if (arguments.length) {
                // Write
                value = arguments[0];
                var ref = self.options.refs[key];
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
                    value.__saved = value.__saved || !!(arguments[2] && value.id());
                    value = value.getJson();
                }
                _stream(value);
                self.__modified = arguments[2] ? false : !arguments[3] && self.__json[key] !== _stream._state.value;
                self.__json[key] = _stream._state.value;
                if (!arguments[1])
                    self.__update(key);
                return value;
            }

            value = _stream();
            defaultVal = self.options && self.options.defaults[key];
            if (_.isNil(value)) {
                if (!_.isNil(defaultVal)) value = defaultVal;
            } else {
                if (value.__model instanceof BaseModel) {
                    value = value.__model;
                } else if (_.isPlainObject(value) && defaultVal instanceof BaseModel) {
                    // Fix invalid value of stream, might be due deleted reference instance model
                    _stream(null);
                    value = defaultVal;
                }
            }
            return (config.placeholder &&
                self.isFetching() &&
                key !== config.keyId &&
                _.indexOf(self.options.placehold, key) > -1 ?
                config.placeholder : value);
        }
        prop.stream = _stream;
        prop.call(this, initial, true, undefined, true);
        return prop;
    }
};

// Inject lodash methods.
util.addMethods(BaseModel.prototype, _, objectMethods, '__json');