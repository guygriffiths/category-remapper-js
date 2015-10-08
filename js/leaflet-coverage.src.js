"format global";
"globals.c3 c3";
"globals.d3 d3";
"globals.L leaflet";
(function(global) {

  var defined = {};

  // indexOf polyfill for IE8
  var indexOf = Array.prototype.indexOf || function(item) {
    for (var i = 0, l = this.length; i < l; i++)
      if (this[i] === item)
        return i;
    return -1;
  }

  var getOwnPropertyDescriptor = true;
  try {
    Object.getOwnPropertyDescriptor({ a: 0 }, 'a');
  }
  catch(e) {
    getOwnPropertyDescriptor = false;
  }

  var defineProperty;
  (function () {
    try {
      if (!!Object.defineProperty({}, 'a', {}))
        defineProperty = Object.defineProperty;
    }
    catch (e) {
      defineProperty = function(obj, prop, opt) {
        try {
          obj[prop] = opt.value || opt.get.call(obj);
        }
        catch(e) {}
      }
    }
  })();

  function register(name, deps, declare) {
    if (arguments.length === 4)
      return registerDynamic.apply(this, arguments);
    doRegister(name, {
      declarative: true,
      deps: deps,
      declare: declare
    });
  }

  function registerDynamic(name, deps, executingRequire, execute) {
    doRegister(name, {
      declarative: false,
      deps: deps,
      executingRequire: executingRequire,
      execute: execute
    });
  }

  function doRegister(name, entry) {
    entry.name = name;

    // we never overwrite an existing define
    if (!(name in defined))
      defined[name] = entry;

    // we have to normalize dependencies
    // (assume dependencies are normalized for now)
    // entry.normalizedDeps = entry.deps.map(normalize);
    entry.normalizedDeps = entry.deps;
  }


  function buildGroups(entry, groups) {
    groups[entry.groupIndex] = groups[entry.groupIndex] || [];

    if (indexOf.call(groups[entry.groupIndex], entry) != -1)
      return;

    groups[entry.groupIndex].push(entry);

    for (var i = 0, l = entry.normalizedDeps.length; i < l; i++) {
      var depName = entry.normalizedDeps[i];
      var depEntry = defined[depName];

      // not in the registry means already linked / ES6
      if (!depEntry || depEntry.evaluated)
        continue;

      // now we know the entry is in our unlinked linkage group
      var depGroupIndex = entry.groupIndex + (depEntry.declarative != entry.declarative);

      // the group index of an entry is always the maximum
      if (depEntry.groupIndex === undefined || depEntry.groupIndex < depGroupIndex) {

        // if already in a group, remove from the old group
        if (depEntry.groupIndex !== undefined) {
          groups[depEntry.groupIndex].splice(indexOf.call(groups[depEntry.groupIndex], depEntry), 1);

          // if the old group is empty, then we have a mixed depndency cycle
          if (groups[depEntry.groupIndex].length == 0)
            throw new TypeError("Mixed dependency cycle detected");
        }

        depEntry.groupIndex = depGroupIndex;
      }

      buildGroups(depEntry, groups);
    }
  }

  function link(name) {
    var startEntry = defined[name];

    startEntry.groupIndex = 0;

    var groups = [];

    buildGroups(startEntry, groups);

    var curGroupDeclarative = !!startEntry.declarative == groups.length % 2;
    for (var i = groups.length - 1; i >= 0; i--) {
      var group = groups[i];
      for (var j = 0; j < group.length; j++) {
        var entry = group[j];

        // link each group
        if (curGroupDeclarative)
          linkDeclarativeModule(entry);
        else
          linkDynamicModule(entry);
      }
      curGroupDeclarative = !curGroupDeclarative; 
    }
  }

  // module binding records
  var moduleRecords = {};
  function getOrCreateModuleRecord(name) {
    return moduleRecords[name] || (moduleRecords[name] = {
      name: name,
      dependencies: [],
      exports: {}, // start from an empty module and extend
      importers: []
    })
  }

  function linkDeclarativeModule(entry) {
    // only link if already not already started linking (stops at circular)
    if (entry.module)
      return;

    var module = entry.module = getOrCreateModuleRecord(entry.name);
    var exports = entry.module.exports;

    var declaration = entry.declare.call(global, function(name, value) {
      module.locked = true;
      exports[name] = value;

      for (var i = 0, l = module.importers.length; i < l; i++) {
        var importerModule = module.importers[i];
        if (!importerModule.locked) {
          for (var j = 0; j < importerModule.dependencies.length; ++j) {
            if (importerModule.dependencies[j] === module) {
              importerModule.setters[j](exports);
            }
          }
        }
      }

      module.locked = false;
      return value;
    });

    module.setters = declaration.setters;
    module.execute = declaration.execute;

    // now link all the module dependencies
    for (var i = 0, l = entry.normalizedDeps.length; i < l; i++) {
      var depName = entry.normalizedDeps[i];
      var depEntry = defined[depName];
      var depModule = moduleRecords[depName];

      // work out how to set depExports based on scenarios...
      var depExports;

      if (depModule) {
        depExports = depModule.exports;
      }
      else if (depEntry && !depEntry.declarative) {
        depExports = depEntry.esModule;
      }
      // in the module registry
      else if (!depEntry) {
        depExports = load(depName);
      }
      // we have an entry -> link
      else {
        linkDeclarativeModule(depEntry);
        depModule = depEntry.module;
        depExports = depModule.exports;
      }

      // only declarative modules have dynamic bindings
      if (depModule && depModule.importers) {
        depModule.importers.push(module);
        module.dependencies.push(depModule);
      }
      else
        module.dependencies.push(null);

      // run the setter for this dependency
      if (module.setters[i])
        module.setters[i](depExports);
    }
  }

  // An analog to loader.get covering execution of all three layers (real declarative, simulated declarative, simulated dynamic)
  function getModule(name) {
    var exports;
    var entry = defined[name];

    if (!entry) {
      exports = load(name);
      if (!exports)
        throw new Error("Unable to load dependency " + name + ".");
    }

    else {
      if (entry.declarative)
        ensureEvaluated(name, []);

      else if (!entry.evaluated)
        linkDynamicModule(entry);

      exports = entry.module.exports;
    }

    if ((!entry || entry.declarative) && exports && exports.__useDefault)
      return exports['default'];

    return exports;
  }

  function linkDynamicModule(entry) {
    if (entry.module)
      return;

    var exports = {};

    var module = entry.module = { exports: exports, id: entry.name };

    // AMD requires execute the tree first
    if (!entry.executingRequire) {
      for (var i = 0, l = entry.normalizedDeps.length; i < l; i++) {
        var depName = entry.normalizedDeps[i];
        var depEntry = defined[depName];
        if (depEntry)
          linkDynamicModule(depEntry);
      }
    }

    // now execute
    entry.evaluated = true;
    var output = entry.execute.call(global, function(name) {
      for (var i = 0, l = entry.deps.length; i < l; i++) {
        if (entry.deps[i] != name)
          continue;
        return getModule(entry.normalizedDeps[i]);
      }
      throw new TypeError('Module ' + name + ' not declared as a dependency.');
    }, exports, module);

    if (output)
      module.exports = output;

    // create the esModule object, which allows ES6 named imports of dynamics
    exports = module.exports;
 
    if (exports && exports.__esModule) {
      entry.esModule = exports;
    }
    else {
      entry.esModule = {};
      
      // don't trigger getters/setters in environments that support them
      if (typeof exports == 'object' || typeof exports == 'function') {
        if (getOwnPropertyDescriptor) {
          var d;
          for (var p in exports)
            if (d = Object.getOwnPropertyDescriptor(exports, p))
              defineProperty(entry.esModule, p, d);
        }
        else {
          var hasOwnProperty = exports && exports.hasOwnProperty;
          for (var p in exports) {
            if (!hasOwnProperty || exports.hasOwnProperty(p))
              entry.esModule[p] = exports[p];
          }
         }
       }
      entry.esModule['default'] = exports;
      defineProperty(entry.esModule, '__useDefault', {
        value: true
      });
    }
  }

  /*
   * Given a module, and the list of modules for this current branch,
   *  ensure that each of the dependencies of this module is evaluated
   *  (unless one is a circular dependency already in the list of seen
   *  modules, in which case we execute it)
   *
   * Then we evaluate the module itself depth-first left to right 
   * execution to match ES6 modules
   */
  function ensureEvaluated(moduleName, seen) {
    var entry = defined[moduleName];

    // if already seen, that means it's an already-evaluated non circular dependency
    if (!entry || entry.evaluated || !entry.declarative)
      return;

    // this only applies to declarative modules which late-execute

    seen.push(moduleName);

    for (var i = 0, l = entry.normalizedDeps.length; i < l; i++) {
      var depName = entry.normalizedDeps[i];
      if (indexOf.call(seen, depName) == -1) {
        if (!defined[depName])
          load(depName);
        else
          ensureEvaluated(depName, seen);
      }
    }

    if (entry.evaluated)
      return;

    entry.evaluated = true;
    entry.module.execute.call(global);
  }

  // magical execution function
  var modules = {};
  function load(name) {
    if (modules[name])
      return modules[name];

    var entry = defined[name];

    // first we check if this module has already been defined in the registry
    if (!entry)
      throw "Module " + name + " not present.";

    // recursively ensure that the module and all its 
    // dependencies are linked (with dependency group handling)
    link(name);

    // now handle dependency execution in correct order
    ensureEvaluated(name, []);

    // remove from the registry
    defined[name] = undefined;

    // exported modules get __esModule defined for interop
    if (entry.declarative)
      defineProperty(entry.module.exports, '__esModule', { value: true });

    // return the defined module object
    return modules[name] = entry.declarative ? entry.module.exports : entry.esModule;
  };

  return function(mains, depNames, declare) {
    return function(formatDetect) {
      formatDetect(function(deps) {
        var System = {
          _nodeRequire: typeof require != 'undefined' && require.resolve && typeof process != 'undefined' && require,
          register: register,
          registerDynamic: registerDynamic,
          get: load, 
          set: function(name, module) {
            modules[name] = module; 
          },
          newModule: function(module) {
            return module;
          }
        };
        System.set('@empty', {});

        // register external dependencies
        for (var i = 0; i < depNames.length; i++) (function(depName, dep) {
          if (dep && dep.__esModule)
            System.register(depName, [], function(_export) {
              return {
                setters: [],
                execute: function() {
                  for (var p in dep)
                    if (p != '__esModule' && !(typeof p == 'object' && p + '' == 'Module'))
                      _export(p, dep[p]);
                }
              };
            });
          else
            System.registerDynamic(depName, [], false, function() {
              return dep;
            });
        })(depNames[i], arguments[i]);

        // register modules in this bundle
        declare(System);

        // load mains
        var firstLoad = load(mains[0]);
        if (mains.length > 1)
          for (var i = 1; i < mains.length; i++)
            load(mains[i]);

        if (firstLoad.__useDefault)
          return firstLoad['default'];
        else
          return firstLoad;
      });
    };
  };

})(typeof self != 'undefined' ? self : global)
/* (['mainModule'], ['external-dep'], function($__System) {
  System.register(...);
})
(function(factory) {
  if (typeof define && define.amd)
    define(['external-dep'], factory);
  // etc UMD / module pattern
})*/

(['0', '1', '2', '3'], ["1","1","1","1","1","1","1","1","1","3"], function($__System) {

(function(__global) {
  var loader = $__System;
  var indexOf = Array.prototype.indexOf || function(item) {
    for (var i = 0, l = this.length; i < l; i++)
      if (this[i] === item)
        return i;
    return -1;
  }

  var commentRegEx = /(\/\*([\s\S]*?)\*\/|([^:]|^)\/\/(.*)$)/mg;
  var cjsRequirePre = "(?:^|[^$_a-zA-Z\\xA0-\\uFFFF.])";
  var cjsRequirePost = "\\s*\\(\\s*(\"([^\"]+)\"|'([^']+)')\\s*\\)";
  var fnBracketRegEx = /\(([^\)]*)\)/;
  var wsRegEx = /^\s+|\s+$/g;
  
  var requireRegExs = {};

  function getCJSDeps(source, requireIndex) {

    // remove comments
    source = source.replace(commentRegEx, '');

    // determine the require alias
    var params = source.match(fnBracketRegEx);
    var requireAlias = (params[1].split(',')[requireIndex] || 'require').replace(wsRegEx, '');

    // find or generate the regex for this requireAlias
    var requireRegEx = requireRegExs[requireAlias] || (requireRegExs[requireAlias] = new RegExp(cjsRequirePre + requireAlias + cjsRequirePost, 'g'));

    requireRegEx.lastIndex = 0;

    var deps = [];

    var match;
    while (match = requireRegEx.exec(source))
      deps.push(match[2] || match[3]);

    return deps;
  }

  /*
    AMD-compatible require
    To copy RequireJS, set window.require = window.requirejs = loader.amdRequire
  */
  function require(names, callback, errback, referer) {
    // in amd, first arg can be a config object... we just ignore
    if (typeof names == 'object' && !(names instanceof Array))
      return require.apply(null, Array.prototype.splice.call(arguments, 1, arguments.length - 1));

    // amd require
    if (typeof names == 'string' && typeof callback == 'function')
      names = [names];
    if (names instanceof Array) {
      var dynamicRequires = [];
      for (var i = 0; i < names.length; i++)
        dynamicRequires.push(loader['import'](names[i], referer));
      Promise.all(dynamicRequires).then(function(modules) {
        if (callback)
          callback.apply(null, modules);
      }, errback);
    }

    // commonjs require
    else if (typeof names == 'string') {
      var module = loader.get(names);
      return module.__useDefault ? module['default'] : module;
    }

    else
      throw new TypeError('Invalid require');
  }

  function define(name, deps, factory) {
    if (typeof name != 'string') {
      factory = deps;
      deps = name;
      name = null;
    }
    if (!(deps instanceof Array)) {
      factory = deps;
      deps = ['require', 'exports', 'module'].splice(0, factory.length);
    }

    if (typeof factory != 'function')
      factory = (function(factory) {
        return function() { return factory; }
      })(factory);

    // in IE8, a trailing comma becomes a trailing undefined entry
    if (deps[deps.length - 1] === undefined)
      deps.pop();

    // remove system dependencies
    var requireIndex, exportsIndex, moduleIndex;
    
    if ((requireIndex = indexOf.call(deps, 'require')) != -1) {
      
      deps.splice(requireIndex, 1);

      // only trace cjs requires for non-named
      // named defines assume the trace has already been done
      if (!name)
        deps = deps.concat(getCJSDeps(factory.toString(), requireIndex));
    }

    if ((exportsIndex = indexOf.call(deps, 'exports')) != -1)
      deps.splice(exportsIndex, 1);
    
    if ((moduleIndex = indexOf.call(deps, 'module')) != -1)
      deps.splice(moduleIndex, 1);

    var define = {
      name: name,
      deps: deps,
      execute: function(req, exports, module) {

        var depValues = [];
        for (var i = 0; i < deps.length; i++)
          depValues.push(req(deps[i]));

        module.uri = module.id;

        module.config = function() {};

        // add back in system dependencies
        if (moduleIndex != -1)
          depValues.splice(moduleIndex, 0, module);
        
        if (exportsIndex != -1)
          depValues.splice(exportsIndex, 0, exports);
        
        if (requireIndex != -1) 
          depValues.splice(requireIndex, 0, function(names, callback, errback) {
            if (typeof names == 'string' && typeof callback != 'function')
              return req(names);
            return require.call(loader, names, callback, errback, module.id);
          });

        // set global require to AMD require
        var curRequire = __global.require;
        __global.require = require;

        var output = factory.apply(exportsIndex == -1 ? __global : exports, depValues);

        __global.require = curRequire;

        if (typeof output == 'undefined' && module)
          output = module.exports;

        if (typeof output != 'undefined')
          return output;
      }
    };

    // anonymous define
    if (!name) {
      // already defined anonymously -> throw
      if (lastModule.anonDefine)
        throw new TypeError('Multiple defines for anonymous module');
      lastModule.anonDefine = define;
    }
    // named define
    else {
      // if we don't have any other defines,
      // then let this be an anonymous define
      // this is just to support single modules of the form:
      // define('jquery')
      // still loading anonymously
      // because it is done widely enough to be useful
      if (!lastModule.anonDefine && !lastModule.isBundle) {
        lastModule.anonDefine = define;
      }
      // otherwise its a bundle only
      else {
        // if there is an anonDefine already (we thought it could have had a single named define)
        // then we define it now
        // this is to avoid defining named defines when they are actually anonymous
        if (lastModule.anonDefine && lastModule.anonDefine.name)
          loader.registerDynamic(lastModule.anonDefine.name, lastModule.anonDefine.deps, false, lastModule.anonDefine.execute);

        lastModule.anonDefine = null;
      }

      // note this is now a bundle
      lastModule.isBundle = true;

      // define the module through the register registry
      loader.registerDynamic(name, define.deps, false, define.execute);
    }
  }
  define.amd = {};

  // adds define as a global (potentially just temporarily)
  function createDefine(loader) {
    lastModule.anonDefine = null;
    lastModule.isBundle = false;

    // ensure no NodeJS environment detection
    var oldModule = __global.module;
    var oldExports = __global.exports;
    var oldDefine = __global.define;

    __global.module = undefined;
    __global.exports = undefined;
    __global.define = define;

    return function() {
      __global.define = oldDefine;
      __global.module = oldModule;
      __global.exports = oldExports;
    };
  }

  var lastModule = {
    isBundle: false,
    anonDefine: null
  };

  loader.set('@@amd-helpers', loader.newModule({
    createDefine: createDefine,
    require: require,
    define: define,
    lastModule: lastModule
  }));
  loader.amdDefine = define;
  loader.amdRequire = require;
})(typeof self != 'undefined' ? self : global);
(function(__global) {
  var loader = $__System;
  var hasOwnProperty = Object.prototype.hasOwnProperty;
  var indexOf = Array.prototype.indexOf || function(item) {
    for (var i = 0, l = this.length; i < l; i++)
      if (this[i] === item)
        return i;
    return -1;
  }

  function readMemberExpression(p, value) {
    var pParts = p.split('.');
    while (pParts.length)
      value = value[pParts.shift()];
    return value;
  }

  // bare minimum ignores for IE8
  var ignoredGlobalProps = ['_g', 'sessionStorage', 'localStorage', 'clipboardData', 'frames', 'external', 'mozAnimationStartTime', 'webkitStorageInfo', 'webkitIndexedDB'];

  var globalSnapshot;

  function forEachGlobal(callback) {
    if (Object.keys)
      Object.keys(__global).forEach(callback);
    else
      for (var g in __global) {
        if (!hasOwnProperty.call(__global, g))
          continue;
        callback(g);
      }
  }

  function forEachGlobalValue(callback) {
    forEachGlobal(function(globalName) {
      if (indexOf.call(ignoredGlobalProps, globalName) != -1)
        return;
      try {
        var value = __global[globalName];
      }
      catch (e) {
        ignoredGlobalProps.push(globalName);
      }
      callback(globalName, value);
    });
  }

  loader.set('@@global-helpers', loader.newModule({
    prepareGlobal: function(moduleName, exportName, globals) {
      // disable module detection
      var curDefine = __global.define;
       
      __global.define = undefined;
      __global.exports = undefined;
      if (__global.module && __global.module.exports)
        __global.module = undefined;

      // set globals
      var oldGlobals;
      if (globals) {
        oldGlobals = {};
        for (var g in globals) {
          oldGlobals[g] = globals[g];
          __global[g] = globals[g];
        }
      }

      // store a complete copy of the global object in order to detect changes
      if (!exportName) {
        globalSnapshot = {};

        forEachGlobalValue(function(name, value) {
          globalSnapshot[name] = value;
        });
      }

      // return function to retrieve global
      return function() {
        var globalValue;

        if (exportName) {
          globalValue = readMemberExpression(exportName, __global);
        }
        else {
          var singleGlobal;
          var multipleExports;
          var exports = {};

          forEachGlobalValue(function(name, value) {
            if (globalSnapshot[name] === value)
              return;
            if (typeof value == 'undefined')
              return;
            exports[name] = value;

            if (typeof singleGlobal != 'undefined') {
              if (!multipleExports && singleGlobal !== value)
                multipleExports = true;
            }
            else {
              singleGlobal = value;
            }
          });
          globalValue = multipleExports ? exports : singleGlobal;
        }

        // revert globals
        if (oldGlobals) {
          for (var g in oldGlobals)
            __global[g] = oldGlobals[g];
        }
        __global.define = curDefine;

        return globalValue;
      };
    }
  }));

})(typeof self != 'undefined' ? self : global);

"bundle";
$__System.registerDynamic("8", [], false, function(__require, __exports, __module) {
  var _retrieveGlobal = $__System.get("@@global-helpers").prepareGlobal(__module.id, null, null);
  (function() {})();
  return _retrieveGlobal();
});

(function() {
var _removeDefine = $__System.get("@@amd-helpers").createDefine();
define("f", ["27"], function(main) {
  return main;
});

_removeDefine();
})();
$__System.registerDynamic("13", ["28", "29"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  "use strict";
  var _Object$create = require("28")["default"];
  var _Object$setPrototypeOf = require("29")["default"];
  exports["default"] = function(subClass, superClass) {
    if (typeof superClass !== "function" && superClass !== null) {
      throw new TypeError("Super expression must either be null or a function, not " + typeof superClass);
    }
    subClass.prototype = _Object$create(superClass && superClass.prototype, {constructor: {
        value: subClass,
        enumerable: false,
        writable: true,
        configurable: true
      }});
    if (superClass)
      _Object$setPrototypeOf ? _Object$setPrototypeOf(subClass, superClass) : subClass.__proto__ = superClass;
  };
  exports.__esModule = true;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("12", ["2a"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  "use strict";
  var _Object$getOwnPropertyDescriptor = require("2a")["default"];
  exports["default"] = function get(_x, _x2, _x3) {
    var _again = true;
    _function: while (_again) {
      var object = _x,
          property = _x2,
          receiver = _x3;
      desc = parent = getter = undefined;
      _again = false;
      if (object === null)
        object = Function.prototype;
      var desc = _Object$getOwnPropertyDescriptor(object, property);
      if (desc === undefined) {
        var parent = Object.getPrototypeOf(object);
        if (parent === null) {
          return undefined;
        } else {
          _x = parent;
          _x2 = property;
          _x3 = receiver;
          _again = true;
          continue _function;
        }
      } else if ("value" in desc) {
        return desc.value;
      } else {
        var getter = desc.get;
        if (getter === undefined) {
          return undefined;
        }
        return getter.call(receiver);
      }
    }
  };
  exports.__esModule = true;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("14", ["25"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  "use strict";
  var _Object$defineProperty = require("25")["default"];
  exports["default"] = (function() {
    function defineProperties(target, props) {
      for (var i = 0; i < props.length; i++) {
        var descriptor = props[i];
        descriptor.enumerable = descriptor.enumerable || false;
        descriptor.configurable = true;
        if ("value" in descriptor)
          descriptor.writable = true;
        _Object$defineProperty(target, descriptor.key, descriptor);
      }
    }
    return function(Constructor, protoProps, staticProps) {
      if (protoProps)
        defineProperties(Constructor.prototype, protoProps);
      if (staticProps)
        defineProperties(Constructor, staticProps);
      return Constructor;
    };
  })();
  exports.__esModule = true;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("15", [], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  "use strict";
  exports["default"] = function(instance, Constructor) {
    if (!(instance instanceof Constructor)) {
      throw new TypeError("Cannot call a class as a function");
    }
  };
  exports.__esModule = true;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("16", ["1e", "2b"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  "use strict";
  var _getIterator = require("1e")["default"];
  var _isIterable = require("2b")["default"];
  exports["default"] = (function() {
    function sliceIterator(arr, i) {
      var _arr = [];
      var _n = true;
      var _d = false;
      var _e = undefined;
      try {
        for (var _i = _getIterator(arr),
            _s; !(_n = (_s = _i.next()).done); _n = true) {
          _arr.push(_s.value);
          if (i && _arr.length === i)
            break;
        }
      } catch (err) {
        _d = true;
        _e = err;
      } finally {
        try {
          if (!_n && _i["return"])
            _i["return"]();
        } finally {
          if (_d)
            throw _e;
        }
      }
      return _arr;
    }
    return function(arr, i) {
      if (Array.isArray(arr)) {
        return arr;
      } else if (_isIterable(Object(arr))) {
        return sliceIterator(arr, i);
      } else {
        throw new TypeError("Invalid attempt to destructure non-iterable instance");
      }
    };
  })();
  exports.__esModule = true;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("17", ["25"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  "use strict";
  var _Object$defineProperty = require("25")["default"];
  exports["default"] = function(obj, key, value) {
    if (key in obj) {
      _Object$defineProperty(obj, key, {
        value: value,
        enumerable: true,
        configurable: true,
        writable: true
      });
    } else {
      obj[key] = value;
    }
    return obj;
  };
  exports.__esModule = true;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("18", ["2c"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  module.exports = {
    "default": require("2c"),
    __esModule: true
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("19", ["2d"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  module.exports = require("2d");
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("1d", ["2f"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  module.exports = {
    "default": require("2f"),
    __esModule: true
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("1e", ["30"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  module.exports = {
    "default": require("30"),
    __esModule: true
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("1f", ["31"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  module.exports = {
    "default": require("31"),
    __esModule: true
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("1c", ["24"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  "use strict";
  var _Array$from = require("24")["default"];
  exports["default"] = function(arr) {
    if (Array.isArray(arr)) {
      for (var i = 0,
          arr2 = Array(arr.length); i < arr.length; i++)
        arr2[i] = arr[i];
      return arr2;
    } else {
      return _Array$from(arr);
    }
  };
  exports.__esModule = true;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("20", ["32"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  module.exports = {
    "default": require("32"),
    __esModule: true
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("22", ["33"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  module.exports = require("33");
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("21", ["34"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  module.exports = {
    "default": require("34"),
    __esModule: true
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("23", ["35"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  module.exports = {
    "default": require("35"),
    __esModule: true
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("24", ["36"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  module.exports = {
    "default": require("36"),
    __esModule: true
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("25", ["37"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  module.exports = {
    "default": require("37"),
    __esModule: true
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("28", ["38"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  module.exports = {
    "default": require("38"),
    __esModule: true
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("29", ["39"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  module.exports = {
    "default": require("39"),
    __esModule: true
  };
  global.define = __define;
  return module.exports;
});

(function() {
var _removeDefine = $__System.get("@@amd-helpers").createDefine();
/^u/.test(typeof define) && function(a) {
  var b = this.require = function(b) {
    return a[b];
  };
  this.define = function(c, d) {
    a[c] = a[c] || d(b);
  };
}({}), define("27", [], function() {
  function a(a) {
    return a.substr(0, 3);
  }
  function b(a) {
    return a != Fa ? "" + a : "";
  }
  function c(a) {
    return "string" == typeof a;
  }
  function d(a) {
    return !!a && "object" == typeof a;
  }
  function e(a) {
    return a && a.nodeType;
  }
  function f(a) {
    return "number" == typeof a;
  }
  function g(a) {
    return d(a) && !!a.getDay;
  }
  function h(a) {
    return !0 === a || !1 === a;
  }
  function i(a) {
    var b = typeof a;
    return "object" == b ? !(!a || !a.getDay) : "string" == b || "number" == b || h(a);
  }
  function j(a) {
    return a;
  }
  function k(a) {
    return a + 1;
  }
  function l(a, c, d) {
    return b(a).replace(c, d != Fa ? d : "");
  }
  function m(a) {
    return l(a, /[\\\[\]\/{}()*+?.$|^-]/g, "\\$&");
  }
  function n(a) {
    return l(a, /^\s+|\s+$/g);
  }
  function o(a, b, c) {
    for (var d in a)
      a.hasOwnProperty(d) && b.call(c || a, d, a[d]);
    return a;
  }
  function p(a, b, c) {
    if (a)
      for (var d = 0; d < a.length; d++)
        b.call(c || a, a[d], d);
    return a;
  }
  function q(a, b, c) {
    var d = [],
        e = ea(b) ? b : function(a) {
          return b != a;
        };
    return p(a, function(b, f) {
      e.call(c || a, b, f) && d.push(b);
    }), d;
  }
  function r(a, b, c, d) {
    var e = [];
    return a(b, function(a, f) {
      fa(a = c.call(d || b, a, f)) ? p(a, function(a) {
        e.push(a);
      }) : a != Fa && e.push(a);
    }), e;
  }
  function s(a, b, c) {
    return r(p, a, b, c);
  }
  function t(a) {
    var b = 0;
    return o(a, function() {
      b++;
    }), b;
  }
  function u(a) {
    var b = [];
    return o(a, function(a) {
      b.push(a);
    }), b;
  }
  function v(a, b, c) {
    var d = [];
    return p(a, function(e, f) {
      d.push(b.call(c || a, e, f));
    }), d;
  }
  function w(a, b) {
    if (fa(a)) {
      var c = wa(b);
      return M(G(a, 0, c.length), c);
    }
    return b != Fa && a.substr(0, b.length) == b;
  }
  function x(a, b) {
    if (fa(a)) {
      var c = wa(b);
      return M(G(a, -c.length), c) || !c.length;
    }
    return b != Fa && a.substr(a.length - b.length) == b;
  }
  function y(a) {
    var b = a.length;
    return fa(a) ? new va(v(a, function() {
      return a[--b];
    })) : l(a, /[\s\S]/g, function() {
      return a.charAt(--b);
    });
  }
  function z(a, b) {
    var c = {};
    return p(a, function(a) {
      c[a] = b;
    }), c;
  }
  function A(a, b) {
    var c,
        d = b || {};
    for (c in a)
      d[c] = a[c];
    return d;
  }
  function B(a, b) {
    for (var c = b,
        d = 0; d < a.length; d++)
      c = A(a[d], c);
    return c;
  }
  function C(a) {
    return ea(a) ? a : function(b, c) {
      return a === b ? c : void 0;
    };
  }
  function D(a, b, c) {
    return b == Fa ? c : 0 > b ? Math.max(a.length + b, 0) : Math.min(a.length, b);
  }
  function E(a, b, c, d) {
    b = C(b), d = D(a, d, a.length);
    for (var e = D(a, c, 0); d > e; e++)
      if ((c = b.call(a, a[e], e)) != Fa)
        return c;
  }
  function F(a, b, c, d) {
    b = C(b), d = D(a, d, -1);
    for (var e = D(a, c, a.length - 1); e > d; e--)
      if ((c = b.call(a, a[e], e)) != Fa)
        return c;
  }
  function G(a, b, c) {
    var d = [];
    if (a)
      for (c = D(a, c, a.length), b = D(a, b, 0); c > b; b++)
        d.push(a[b]);
    return d;
  }
  function H(a) {
    return v(a, j);
  }
  function I(a) {
    return function() {
      return new va(O(a, arguments));
    };
  }
  function J(a) {
    var b = {};
    return q(a, function(a) {
      return b[a] ? !1 : b[a] = 1;
    });
  }
  function K(a, b) {
    var c = z(b, 1);
    return q(a, function(a) {
      var b = c[a];
      return c[a] = 0, b;
    });
  }
  function L(a, b) {
    for (var c = 0; c < a.length; c++)
      if (a[c] == b)
        return !0;
    return !1;
  }
  function M(a, b) {
    var c,
        d = ea(a) ? a() : a,
        e = ea(b) ? b() : b;
    return d == e ? !0 : d == Fa || e == Fa ? !1 : i(d) || i(e) ? g(d) && g(e) && +d == +e : fa(d) ? d.length == e.length && !E(d, function(a, b) {
      return M(a, e[b]) ? void 0 : !0;
    }) : !fa(e) && (c = u(d)).length == t(e) && !E(c, function(a) {
      return M(d[a], e[a]) ? void 0 : !0;
    });
  }
  function N(a, b, c) {
    return ea(a) ? a.apply(c && b, v(c || b, j)) : void 0;
  }
  function O(a, b, c) {
    return v(a, function(a) {
      return N(a, b, c);
    });
  }
  function P(a, b, c, d) {
    return function() {
      return N(a, b, s([c, arguments, d], j));
    };
  }
  function Q(a, b) {
    for (var c = 0 > b ? "-" : "",
        d = (c ? -b : b).toFixed(0); d.length < a; )
      d = "0" + d;
    return c + d;
  }
  function R(a, b, c) {
    var d,
        e = 0,
        f = c ? b : y(b);
    return a = (c ? a : y(a)).replace(/./g, function(a) {
      return "0" == a ? (d = !1, f.charAt(e++) || "0") : "#" == a ? (d = !0, f.charAt(e++) || "") : d && !f.charAt(e) ? "" : a;
    }), c ? a : b.substr(0, b.length - e) + y(a);
  }
  function S(a, b, c) {
    return b != Fa && a ? 60 * parseFloat(a[b] + a[b + 1]) + parseFloat(a[b] + a[b + 2]) + c.getTimezoneOffset() : 0;
  }
  function T(a) {
    return new Date(+a);
  }
  function U(a, b, c) {
    return a["set" + b](a["get" + b]() + c), a;
  }
  function V(a, b, c) {
    return c == Fa ? V(new Date, a, b) : U(T(a), b.charAt(0).toUpperCase() + b.substr(1), c);
  }
  function W(a, b, c) {
    var d = +b,
        e = +c,
        f = e - d;
    if (0 > f)
      return -W(a, c, b);
    if (b = {
      milliseconds: 1,
      seconds: 1e3,
      minutes: 6e4,
      hours: 36e5
    }[a])
      return f / b;
    for (b = a.charAt(0).toUpperCase() + a.substr(1), a = Math.floor(f / {
      fullYear: 31536e6,
      month: 2628e6,
      date: 864e5
    }[a] - 2), d = U(new Date(d), b, a), f = a; 1.2 * a + 4 > f; f++)
      if (+U(d, b, 1) > e)
        return f;
  }
  function X(a) {
    return "\\u" + ("0000" + a.charCodeAt(0).toString(16)).slice(-4);
  }
  function Y(a) {
    return l(a, /[\x00-\x1f'"\u2028\u2029]/g, X);
  }
  function Z(a, b) {
    return a.split(b);
  }
  function $(a, b) {
    function c(a, c) {
      var d = [];
      return e.call(c || a, a, function(a, b) {
        fa(a) ? p(a, function(a, c) {
          b.call(a, a, c);
        }) : o(a, function(a, c) {
          b.call(c, a, c);
        });
      }, b || j, function() {
        N(d.push, d, arguments);
      }, wa), d.join("");
    }
    if (Ma[a])
      return Ma[a];
    var d = "with(_.isObject(obj)?obj:{}){" + v(Z(a, /{{|}}}?/g), function(a, b) {
      var c,
          d = n(a),
          e = l(d, /^{/),
          d = d == e ? "esc(" : "";
      return b % 2 ? (c = /^each\b(\s+([\w_]+(\s*,\s*[\w_]+)?)\s*:)?(.*)/.exec(e)) ? "each(" + (n(c[4]) ? c[4] : "this") + ", function(" + c[2] + "){" : (c = /^if\b(.*)/.exec(e)) ? "if(" + c[1] + "){" : (c = /^else\b\s*(if\b(.*))?/.exec(e)) ? "}else " + (c[1] ? "if(" + c[2] + ")" : "") + "{" : (c = /^\/(if)?/.exec(e)) ? c[1] ? "}\n" : "});\n" : (c = /^(var\s.*)/.exec(e)) ? c[1] + ";" : (c = /^#(.*)/.exec(e)) ? c[1] : (c = /(.*)::\s*(.*)/.exec(e)) ? "print(" + d + '_.formatValue("' + Y(c[2]) + '",' + (n(c[1]) ? c[1] : "this") + (d && ")") + "));\n" : "print(" + d + (n(e) ? e : "this") + (d && ")") + ");\n" : a ? 'print("' + Y(a) + '");\n' : void 0;
    }).join("") + "}",
        e = Function("obj", "each", "esc", "print", "_", d);
    return 99 < Na.push(c) && delete Ma[Na.shift()], Ma[a] = c;
  }
  function _(a) {
    return l(a, /[<>'"&]/g, function(a) {
      return "&#" + a.charCodeAt(0) + ";";
    });
  }
  function aa(a, b) {
    return $(a, _)(b);
  }
  function ba(a) {
    return function(b, c) {
      return new va(a(this, b, c));
    };
  }
  function ca(a) {
    return function(b, c, d) {
      return a(this, b, c, d);
    };
  }
  function da(a) {
    return function(b, c, d) {
      return new va(a(b, c, d));
    };
  }
  function ea(a) {
    return "function" == typeof a && !a.item;
  }
  function fa(a) {
    return a && a.length != Fa && !c(a) && !e(a) && !ea(a) && a !== ya;
  }
  function ga(a) {
    return parseFloat(l(a, /^[^\d-]+/));
  }
  function ha(a) {
    return a.Nia = a.Nia || ++Ba;
  }
  function ia(a, b) {
    var c,
        d = [],
        e = {};
    return sa(a, function(a) {
      sa(b(a), function(a) {
        e[c = ha(a)] || (d.push(a), e[c] = !0);
      });
    }), d;
  }
  function ja(a, b) {
    var c = {
      $position: "absolute",
      $visibility: "hidden",
      $display: "block",
      $height: Fa
    },
        d = a.get(c),
        c = a.set(c).get("clientHeight");
    return a.set(d), c * b + "px";
  }
  function ka(a) {
    Ca ? Ca.push(a) : setTimeout(a, 0);
  }
  function la(a, b, c) {
    return pa(a, b, c)[0];
  }
  function ma(a, b, c) {
    return a = oa(document.createElement(a)), fa(b) || b != Fa && !d(b) ? a.add(b) : a.set(b).add(c);
  }
  function na(a) {
    return r(sa, a, function(a) {
      return fa(a) ? na(a) : (e(a) && (a = a.cloneNode(!0), a.removeAttribute && a.removeAttribute("id")), a);
    });
  }
  function oa(a, b, c) {
    return ea(a) ? ka(a) : new va(pa(a, b, c));
  }
  function pa(a, b, d) {
    function f(a) {
      return fa(a) ? r(sa, a, f) : a;
    }
    function g(a) {
      return q(r(sa, a, f), function(a) {
        for (; a = a.parentNode; )
          if (a == b[0] || d)
            return a == b[0];
      });
    }
    return b ? 1 != (b = pa(b)).length ? ia(b, function(b) {
      return pa(a, b, d);
    }) : c(a) ? 1 != e(b[0]) ? [] : d ? g(b[0].querySelectorAll(a)) : b[0].querySelectorAll(a) : g(a) : c(a) ? document.querySelectorAll(a) : r(sa, a, f);
  }
  function qa(a, b) {
    function d(a, b) {
      var c = RegExp("(^|\\s+)" + a + "(?=$|\\s)", "i");
      return function(d) {
        return a ? c.test(d[b]) : !0;
      };
    }
    var g,
        h,
        i = {},
        j = i;
    return ea(a) ? a : f(a) ? function(b, c) {
      return c == a;
    } : !a || "*" == a || c(a) && (j = /^([\w-]*)\.?([\w-]*)$/.exec(a)) ? (g = d(j[1], "tagName"), h = d(j[2], "className"), function(a) {
      return 1 == e(a) && g(a) && h(a);
    }) : b ? function(c) {
      return oa(a, b).find(c) != Fa;
    } : (oa(a).each(function(a) {
      i[ha(a)] = !0;
    }), function(a) {
      return i[ha(a)];
    });
  }
  function ra(a) {
    var b = qa(a);
    return function(a) {
      return b(a) ? Fa : !0;
    };
  }
  function sa(a, b) {
    return fa(a) ? p(a, b) : a != Fa && b(a, 0), a;
  }
  function ta() {
    this.state = null, this.values = [], this.parent = null;
  }
  function ua() {
    var a,
        b,
        c = [],
        e = arguments,
        f = e.length,
        g = 0,
        h = 0,
        i = new ta;
    return i.errHandled = function() {
      h++, i.parent && i.parent.errHandled();
    }, a = i.fire = function(a, b) {
      return null == i.state && null != a && (i.state = !!a, i.values = fa(b) ? b : [b], setTimeout(function() {
        p(c, function(a) {
          a();
        });
      }, 0)), i;
    }, p(e, function j(b, c) {
      try {
        b.then ? b.then(function(b) {
          (d(b) || ea(b)) && ea(b.then) ? j(b, c) : (i.values[c] = H(arguments), ++g == f && a(!0, 2 > f ? i.values[c] : i.values));
        }, function() {
          i.values[c] = H(arguments), a(!1, 2 > f ? i.values[c] : [i.values[c][0], i.values, c]);
        }) : b(function() {
          a(!0, H(arguments));
        }, function() {
          a(!1, H(arguments));
        });
      } catch (e) {
        a(!1, [e, i.values, c]);
      }
    }), i.stop = function() {
      return p(e, function(a) {
        a.stop && a.stop();
      }), i.stop0 && N(i.stop0);
    }, b = i.then = function(a, b) {
      function e() {
        try {
          var c = i.state ? a : b;
          ea(c) ? function g(a) {
            try {
              var b,
                  c = 0;
              if ((d(a) || ea(a)) && ea(b = a.then)) {
                if (a === f)
                  throw new TypeError;
                b.call(a, function(a) {
                  c++ || g(a);
                }, function(a) {
                  c++ || f.fire(!1, [a]);
                }), f.stop0 = a.stop;
              } else
                f.fire(!0, [a]);
            } catch (e) {
              if (!c++ && (f.fire(!1, [e]), !h))
                throw e;
            }
          }(N(c, xa, i.values)) : f.fire(i.state, i.values);
        } catch (e) {
          if (f.fire(!1, [e]), !h)
            throw e;
        }
      }
      var f = ua();
      return ea(b) && i.errHandled(), f.stop0 = i.stop, f.parent = i, null != i.state ? setTimeout(e, 0) : c.push(e), f;
    }, i.always = function(a) {
      return b(a, a);
    }, i.error = function(a) {
      return b(0, a);
    }, i;
  }
  function va(a, b) {
    var c,
        d,
        e,
        f,
        g,
        h = 0;
    if (a)
      for (c = 0, d = a.length; d > c; c++)
        if (e = a[c], b && fa(e))
          for (f = 0, g = e.length; g > f; f++)
            this[h++] = e[f];
        else
          this[h++] = e;
    else
      this[h++] = b;
    this.length = h, this._ = !0;
  }
  function wa() {
    return new va(arguments, !0);
  }
  var xa,
      ya = window,
      za = {},
      Aa = {},
      Ba = 1,
      Ca = /^[ic]/.test(document.readyState) ? Fa : [],
      Da = {},
      Ea = 0,
      Fa = null,
      Ga = Z("January,February,March,April,May,June,July,August,September,October,November,December", /,/g),
      Ha = v(Ga, a),
      Ia = Z("Sunday,Monday,Tuesday,Wednesday,Thursday,Friday,Saturday", /,/g),
      Ja = v(Ia, a),
      Ka = {
        y: ["FullYear", j],
        Y: ["FullYear", function(a) {
          return a % 100;
        }],
        M: ["Month", k],
        n: ["Month", Ha],
        N: ["Month", Ga],
        d: ["Date", j],
        m: ["Minutes", j],
        H: ["Hours", j],
        h: ["Hours", function(a) {
          return a % 12 || 12;
        }],
        k: ["Hours", k],
        K: ["Hours", function(a) {
          return a % 12;
        }],
        s: ["Seconds", j],
        S: ["Milliseconds", j],
        a: ["Hours", Z("am,am,am,am,am,am,am,am,am,am,am,am,pm,pm,pm,pm,pm,pm,pm,pm,pm,pm,pm,pm", /,/g)],
        w: ["Day", Ja],
        W: ["Day", Ia],
        z: ["TimezoneOffset", function(a, b, c) {
          return c ? c : (b = 0 > a ? -a : a, (a > 0 ? "-" : "+") + Q(2, Math.floor(b / 60)) + Q(2, b % 60));
        }]
      },
      La = {
        y: 0,
        Y: [0, -2e3],
        M: [1, 1],
        n: [1, Ha],
        N: [1, Ga],
        d: 2,
        m: 4,
        H: 3,
        h: 3,
        K: [3, 1],
        k: [3, 1],
        s: 5,
        S: 6,
        a: [3, Z("am,pm", /,/g)]
      },
      Ma = {},
      Na = [];
  return A({
    each: ca(p),
    filter: ba(q),
    collect: ba(s),
    map: ba(v),
    toObject: ca(z),
    equals: ca(M),
    sub: ba(G),
    reverse: ca(y),
    find: ca(E),
    findLast: ca(F),
    startsWith: ca(w),
    endsWith: ca(x),
    contains: ca(L),
    call: ba(O),
    array: ca(H),
    unite: ca(I),
    merge: ca(B),
    uniq: ba(J),
    intersection: ba(K),
    join: function(a) {
      return v(this, j).join(a);
    },
    reduce: function(a, b) {
      return p(this, function(c, d) {
        b = a.call(this, b, c, d);
      }), b;
    },
    sort: function(a) {
      return new va(v(this, j).sort(a));
    },
    remove: function() {
      sa(this, function(a) {
        a.parentNode.removeChild(a);
      });
    },
    text: function() {
      return r(sa, this, function(a) {
        return a.textContent;
      }).join("");
    },
    trav: function(a, b, c) {
      var d = f(b),
          e = qa(d ? Fa : b),
          g = d ? b : c;
      return new va(ia(this, function(b) {
        for (var c = []; (b = b[a]) && c.length != g; )
          e(b) && c.push(b);
        return c;
      }));
    },
    next: function(a, b) {
      return this.trav("nextSibling", a, b || 1);
    },
    up: function(a, b) {
      return this.trav("parentNode", a, b || 1);
    },
    select: function(a, b) {
      return oa(a, this, b);
    },
    is: function(a) {
      return !this.find(ra(a));
    },
    only: function(a) {
      return new va(q(this, qa(a)));
    },
    not: function(a) {
      return new va(q(this, ra(a)));
    },
    get: function(a, b) {
      var d,
          e,
          f,
          g,
          h = this,
          i = h[0];
      return i ? c(a) ? (d = /^(\W*)(.*)/.exec(l(a, /^%/, "@data-")), e = d[1], f = Aa[e] ? Aa[e](this, d[2]) : "$" == a ? h.get("className") : "$$" == a ? h.get("@style") : "$$slide" == a ? h.get("$height") : "$$fade" == a || "$$show" == a ? "hidden" == h.get("$visibility") || "none" == h.get("$display") ? 0 : "$$fade" == a ? isNaN(h.get("$opacity", !0)) ? 1 : h.get("$opacity", !0) : 1 : "$" == e ? ya.getComputedStyle(i, Fa).getPropertyValue(l(d[2], /[A-Z]/g, function(a) {
        return "-" + a.toLowerCase();
      })) : "@" == e ? i.getAttribute(d[2]) : i[d[2]], b ? ga(f) : f) : (g = {}, (fa(a) ? sa : o)(a, function(a) {
        g[a] = h.get(a, b);
      }), g) : void 0;
    },
    set: function(a, b) {
      var d,
          e,
          f = this;
      return b !== xa ? (d = /^(\W*)(.*)/.exec(l(l(a, /^\$float$/, "cssFloat"), /^%/, "@data-")), e = d[1], za[e] ? za[e](this, d[2], b) : "$$fade" == a ? this.set({
        $visibility: b ? "visible" : "hidden",
        $opacity: b
      }) : "$$slide" == a ? f.set({
        $visibility: b ? "visible" : "hidden",
        $overflow: "hidden",
        $height: /px/.test(b) ? b : function(a, c, d) {
          return ja(oa(d), b);
        }
      }) : "$$show" == a ? b ? f.set({
        $visibility: b ? "visible" : "hidden",
        $display: ""
      }).set({$display: function(a) {
          return "none" == a ? "block" : a;
        }}) : f.set({$display: "none"}) : "$$" == a ? f.set("@style", b) : sa(this, function(c, f) {
        var g = ea(b) ? b(oa(c).get(a), f, c) : b;
        "$" == e ? d[2] ? c.style[d[2]] = g : sa(g && g.split(/\s+/), function(a) {
          var b = l(a, /^[+-]/),
              d = c.className || "",
              e = l(d, RegExp("(^|\\s+)" + b + "(?=$|\\s)"));
          (/^\+/.test(a) || b == a && d == e) && (e += " " + b), c.className = n(e);
        }) : "$$scrollX" == a ? c.scroll(g, oa(c).get("$$scrollY")) : "$$scrollY" == a ? c.scroll(oa(c).get("$$scrollX"), g) : "@" == e ? g == Fa ? c.removeAttribute(d[2]) : c.setAttribute(d[2], g) : c[d[2]] = g;
      })) : c(a) || ea(a) ? f.set("$", a) : o(a, function(a, b) {
        f.set(a, b);
      }), f;
    },
    show: function() {
      return this.set("$$show", 1);
    },
    hide: function() {
      return this.set("$$show", 0);
    },
    add: function(a, b) {
      return this.each(function(c, d) {
        function f(a) {
          fa(a) ? sa(a, f) : ea(a) ? f(a(c, d)) : a != Fa && (a = e(a) ? a : document.createTextNode(a), g ? g.parentNode.insertBefore(a, g.nextSibling) : b ? b(a, c, c.parentNode) : c.appendChild(a), g = a);
        }
        var g;
        f(d && !ea(a) ? na(a) : a);
      });
    },
    fill: function(a) {
      return this.each(function(a) {
        oa(a.childNodes).remove();
      }).add(a);
    },
    addAfter: function(a) {
      return this.add(a, function(a, b, c) {
        c.insertBefore(a, b.nextSibling);
      });
    },
    addBefore: function(a) {
      return this.add(a, function(a, b, c) {
        c.insertBefore(a, b);
      });
    },
    addFront: function(a) {
      return this.add(a, function(a, b) {
        b.insertBefore(a, b.firstChild);
      });
    },
    replace: function(a) {
      return this.add(a, function(a, b, c) {
        c.replaceChild(a, b);
      });
    },
    clone: ba(na),
    animate: function(a, b, c) {
      var d,
          e = ua(),
          f = this,
          g = r(sa, this, function(b, d) {
            var e,
                f = oa(b),
                g = {};
            return o(e = f.get(a), function(c, e) {
              var h = a[c];
              g[c] = ea(h) ? h(e, d, b) : "$$slide" == c ? ja(f, h) : h;
            }), f.dial(e, g, c);
          }),
          h = b || 500;
      return e.stop0 = function() {
        return e.fire(!1), d();
      }, d = oa.loop(function(a) {
        O(g, [a / h]), a >= h && (d(), e.fire(!0, [f]));
      }), e;
    },
    dial: function(a, c, d) {
      function e(a, b) {
        return /^#/.test(a) ? parseInt(6 < a.length ? a.substr(2 * b + 1, 2) : (a = a.charAt(b + 1)) + a, 16) : ga(a.split(",")[b]);
      }
      var f = this,
          g = d || 0,
          h = ea(g) ? g : function(a, b, c) {
            return c * (b - a) * (g + (1 - g) * c * (3 - 2 * c)) + a;
          };
      return function(d) {
        o(a, function(a, g) {
          var i = c[a],
              j = 0;
          f.set(a, 0 >= d ? g : d >= 1 ? i : /^#|rgb\(/.test(i) ? "rgb(" + Math.round(h(e(g, j), e(i, j++), d)) + "," + Math.round(h(e(g, j), e(i, j++), d)) + "," + Math.round(h(e(g, j), e(i, j++), d)) + ")" : l(i, /-?[\d.]+/, b(h(ga(g), ga(i), d))));
        });
      };
    },
    toggle: function(a, b, c, d) {
      var e,
          f,
          g = this,
          h = !1;
      return b ? (g.set(a), function(i) {
        i !== h && (f = (h = !0 === i || !1 === i ? i : !h) ? b : a, c ? (e = g.animate(f, e ? e.stop() : c, d)).then(function() {
          e = Fa;
        }) : g.set(f));
      }) : g.toggle(l(a, /\b(?=\w)/g, "-"), l(a, /\b(?=\w)/g, "+"));
    },
    values: function(a) {
      var c = a || {};
      return this.each(function(a) {
        var d = a.name || a.id,
            e = b(a.value);
        if (/form/i.test(a.tagName))
          for (d = 0; d < a.elements.length; d++)
            oa(a.elements[d]).values(c);
        else
          !d || /ox|io/i.test(a.type) && !a.checked || (c[d] = c[d] == Fa ? e : r(sa, [c[d], e], j));
      }), c;
    },
    offset: function() {
      for (var a = this[0],
          b = {
            x: 0,
            y: 0
          }; a; )
        b.x += a.offsetLeft, b.y += a.offsetTop, a = a.offsetParent;
      return b;
    },
    on: function(a, d, e, f, g) {
      return ea(d) ? this.on(Fa, a, d, e, f) : c(f) ? this.on(a, d, e, Fa, f) : this.each(function(c, h) {
        sa(a ? pa(a, c) : c, function(a) {
          sa(b(d).split(/\s/), function(b) {
            function c(b, c, d) {
              var j,
                  l = !g;
              if (d = g ? d : a, g)
                for (j = qa(g, a); d && d != a && !(l = j(d)); )
                  d = d.parentNode;
              return !l || i != b || e.apply(oa(d), f || [c, h]) && "?" == k || "|" == k;
            }
            function d(a) {
              c(i, a, a.target) || (a.preventDefault(), a.stopPropagation());
            }
            var i = l(b, /[?|]/g),
                k = l(b, /[^?|]/g),
                m = ("blur" == i || "focus" == i) && !!g,
                n = Ba++;
            a.addEventListener(i, d, m), a.M || (a.M = {}), a.M[n] = c, e.M = r(sa, [e.M, function() {
              a.removeEventListener(i, d, m), delete a.M[n];
            }], j);
          });
        });
      });
    },
    onOver: function(a, b) {
      var c = this,
          d = [];
      return ea(b) ? this.on(a, "|mouseover |mouseout", function(a, e) {
        var f = a.relatedTarget || a.toElement,
            g = "mouseout" != a.type;
        d[e] === g || !g && f && (f == c[e] || oa(f).up(c[e]).length) || (d[e] = g, b.call(this, g, a));
      }) : this.onOver(Fa, a);
    },
    onFocus: function(a, b, c) {
      return ea(b) ? this.on(a, "|blur", b, [!1], c).on(a, "|focus", b, [!0], c) : this.onFocus(Fa, a, b);
    },
    onChange: function(a, b, c) {
      return ea(b) ? this.on(a, "|input |change |click", function(a, c) {
        var d = this[0],
            e = /ox|io/i.test(d.type) ? d.checked : d.value;
        d.NiaP != e && b.call(this, d.NiaP = e, c);
      }, c) : this.onChange(Fa, a, b);
    },
    onClick: function(a, b, c, d) {
      return ea(b) ? this.on(a, "click", b, c, d) : this.onClick(Fa, a, b, c);
    },
    trigger: function(a, b) {
      return this.each(function(c) {
        for (var d = !0,
            e = c; e && d; )
          o(e.M, function(e, f) {
            d = d && f(a, b, c);
          }), e = e.parentNode;
      });
    },
    per: function(a, b) {
      if (ea(a))
        for (var c = this.length,
            d = 0; c > d; d++)
          a.call(this, new va(Fa, this[d]), d);
      else
        oa(a, this).per(b);
      return this;
    },
    ht: function(a, b) {
      var c = 2 < arguments.length ? B(G(arguments, 1)) : b;
      return this.set("innerHTML", ea(a) ? a(c) : /{{/.test(a) ? aa(a, c) : /^#\S+$/.test(a) ? aa(la(a).text, c) : a);
    }
  }, va.prototype), A({
    request: function(a, c, d, e) {
      e = e || {};
      var f,
          g = 0,
          h = ua(),
          i = d && d.constructor == e.constructor;
      try {
        h.xhr = f = new XMLHttpRequest, h.stop0 = function() {
          f.abort();
        }, i && (d = r(o, d, function(a, b) {
          return r(sa, b, function(b) {
            return encodeURIComponent(a) + (b != Fa ? "=" + encodeURIComponent(b) : "");
          });
        }).join("&")), d == Fa || /post/i.test(a) || (c += "?" + d, d = Fa), f.open(a, c, !0, e.user, e.pass), i && /post/i.test(a) && f.setRequestHeader("Content-Type", "application/x-www-form-urlencoded"), o(e.headers, function(a, b) {
          f.setRequestHeader(a, b);
        }), o(e.xhr, function(a, b) {
          f[a] = b;
        }), f.onreadystatechange = function() {
          4 != f.readyState || g++ || (200 <= f.status && 300 > f.status ? h.fire(!0, [f.responseText, f]) : h.fire(!1, [f.status, f.responseText, f]));
        }, f.send(d);
      } catch (j) {
        g || h.fire(!1, [0, Fa, b(j)]);
      }
      return h;
    },
    toJSON: JSON.stringify,
    parseJSON: JSON.parse,
    ready: ka,
    loop: function(a) {
      function b(a) {
        o(Da, function(b, c) {
          c(a);
        }), Ea && g(b);
      }
      function c() {
        return Da[f] && (delete Da[f], Ea--), e;
      }
      var d,
          e = 0,
          f = Ba++,
          g = ya.requestAnimationFrame || function(a) {
            setTimeout(function() {
              a(+new Date);
            }, 33);
          };
      return Da[f] = function(b) {
        d = d || b, a(e = b - d, c);
      }, Ea++ || g(b), c;
    },
    off: function(a) {
      O(a.M), a.M = Fa;
    },
    setCookie: function(a, b, c, e) {
      document.cookie = a + "=" + (e ? b : escape(b)) + (c ? "; expires=" + (d(c) ? c : new Date(+new Date + 864e5 * c)).toUTCString() : "");
    },
    getCookie: function(a, b) {
      var c,
          d = (c = RegExp("(^|;)\\s*" + a + "=([^;]*)").exec(document.cookie)) && c[2];
      return b ? d : d && unescape(d);
    },
    wait: function(a, b) {
      var c = ua(),
          d = setTimeout(function() {
            c.fire(!0, b);
          }, a);
      return c.stop0 = function() {
        c.fire(!1), clearTimeout(d);
      }, c;
    }
  }, oa), A({
    filter: da(q),
    collect: da(s),
    map: da(v),
    sub: da(G),
    reverse: y,
    each: p,
    toObject: z,
    find: E,
    findLast: F,
    contains: L,
    startsWith: w,
    endsWith: x,
    equals: M,
    call: da(O),
    array: H,
    unite: I,
    merge: B,
    uniq: da(J),
    intersection: da(K),
    keys: da(u),
    values: da(function(a, b) {
      var c = [];
      return b ? p(b, function(b) {
        c.push(a[b]);
      }) : o(a, function(a, b) {
        c.push(b);
      }), c;
    }),
    copyObj: A,
    extend: function(a) {
      return B(G(arguments, 1), a);
    },
    range: function(a, b) {
      for (var c = [],
          d = b == Fa ? a : b,
          e = b != Fa ? a : 0; d > e; e++)
        c.push(e);
      return new va(c);
    },
    bind: P,
    partial: function(a, b, c) {
      return P(a, this, b, c);
    },
    eachObj: o,
    mapObj: function(a, b, c) {
      var d = {};
      return o(a, function(e, f) {
        d[e] = b.call(c || a, e, f);
      }), d;
    },
    filterObj: function(a, b, c) {
      var d = {};
      return o(a, function(e, f) {
        b.call(c || a, e, f) && (d[e] = f);
      }), d;
    },
    isList: fa,
    isFunction: ea,
    isObject: d,
    isNumber: f,
    isBool: h,
    isDate: g,
    isValue: i,
    isString: c,
    toString: b,
    dateClone: T,
    dateAdd: V,
    dateDiff: W,
    dateMidnight: function(a) {
      return a = a || new Date, new Date(a.getFullYear(), a.getMonth(), a.getDate());
    },
    pad: Q,
    formatValue: function(a, d) {
      var e,
          h,
          i = l(a, /^\?/);
      return g(d) ? ((h = /^\[(([+-])(\d\d)(\d\d))\]\s*(.*)/.exec(i)) && (e = h[1], d = V(d, "minutes", S(h, 2, d)), i = h[5]), l(i, /(\w)(\1*)(?:\[([^\]]+)\])?/g, function(a, b, f, g) {
        return (b = Ka[b]) && (a = d["get" + b[0]](), g = g && g.split(","), a = fa(b[1]) ? (g || b[1])[a] : b[1](a, g, e), a == Fa || c(a) || (a = Q(f.length + 1, a))), a;
      })) : E(i.split(/\s*\|\s*/), function(a) {
        var c,
            e;
        if (c = /^([<>]?)(=?)([^:]*?)\s*:\s*(.*)$/.exec(a)) {
          if (a = d, e = +c[3], (isNaN(e) || !f(a)) && (a = a == Fa ? "null" : b(a), e = c[3]), c[1]) {
            if (!c[2] && a == e || "<" == c[1] && a > e || ">" == c[1] && e > a)
              return Fa;
          } else if (a != e)
            return Fa;
          c = c[4];
        } else
          c = a;
        return f(d) ? c.replace(/[0#](.*[0#])?/, function(a) {
          var b,
              c = /^([^.]+)(\.)([^.]+)$/.exec(a) || /^([^,]+)(,)([^,]+)$/.exec(a),
              e = 0 > d ? "-" : "",
              f = /(\d+)(\.(\d+))?/.exec((e ? -d : d).toFixed(c ? c[3].length : 0));
          return a = c ? c[1] : a, b = c ? R(c[3], l(f[3], /0+$/), !0) : "", (e ? "-" : "") + ("#" == a ? f[1] : R(a, f[1])) + (b.length ? c[2] : "") + b;
        }) : c;
      });
    },
    parseDate: function(a, b) {
      var c,
          d,
          e,
          f,
          g,
          h,
          i,
          j,
          k,
          o = {},
          p = 1,
          q = l(a, /^\?/);
      if (q != a && !n(b))
        return Fa;
      if ((e = /^\[([+-])(\d\d)(\d\d)\]\s*(.*)/.exec(q)) && (c = e, q = e[4]), !(e = RegExp(q.replace(/(.)(\1*)(?:\[([^\]]*)\])?/g, function(a, b, c, e) {
        return /[dmhkyhs]/i.test(b) ? (o[p++] = b, a = c.length + 1, "(\\d" + (2 > a ? "+" : "{1," + a + "}") + ")") : "z" == b ? (d = p, p += 3, "([+-])(\\d\\d)(\\d\\d)") : /[Nna]/.test(b) ? (o[p++] = [b, e && e.split(",")], "([a-zA-Z\\u0080-\\u1fff]+)") : /w/i.test(b) ? "[a-zA-Z\\u0080-\\u1fff]+" : /\s/.test(b) ? "\\s+" : m(a);
      })).exec(b)))
        return xa;
      for (q = [0, 0, 0, 0, 0, 0, 0], f = 1; p > f; f++)
        if (g = e[f], h = o[f], fa(h)) {
          if (i = h[0], j = La[i], k = j[0], h = E(h[1] || j[1], function(a, b) {
            return w(g.toLowerCase(), a.toLowerCase()) ? b : void 0;
          }), h == Fa)
            return xa;
          q[k] = "a" == i ? q[k] + 12 * h : h;
        } else
          h && (i = parseFloat(g), j = La[h], fa(j) ? q[j[0]] += i - j[1] : q[j] += i);
      return q = new Date(q[0], q[1], q[2], q[3], q[4], q[5], q[6]), V(q, "minutes", -S(c, 1, q) - S(e, d, q));
    },
    parseNumber: function(a, b) {
      var c = l(a, /^\?/);
      return c == a || n(b) ? (c = /(^|[^0#.,])(,|[0#.]*,[0#]+|[0#]+\.[0#]+\.[0#.,]*)($|[^0#.,])/.test(c) ? "," : ".", c = parseFloat(l(l(l(b, "," == c ? /\./g : /,/g), c, "."), /^[^\d-]*(-?\d)/, "$1")), isNaN(c) ? xa : c) : Fa;
    },
    trim: n,
    isEmpty: function(a, b) {
      return a == Fa || !a.length || b && /^\s*$/.test(a);
    },
    escapeRegExp: m,
    escapeHtml: _,
    format: function(a, b, c) {
      return $(a, c)(b);
    },
    template: $,
    formatHtml: aa,
    promise: ua
  }, wa), document.addEventListener("DOMContentLoaded", function() {
    O(Ca), Ca = Fa;
  }, !1), {
    HTML: function() {
      var a = ma("div");
      return wa(N(a.ht, a, arguments)[0].childNodes);
    },
    _: wa,
    $: oa,
    $$: la,
    EE: ma,
    M: va,
    getter: Aa,
    setter: za
  };
});

_removeDefine();
})();
$__System.registerDynamic("2a", ["3a"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  module.exports = {
    "default": require("3a"),
    __esModule: true
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("2b", ["3b"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  module.exports = {
    "default": require("3b"),
    __esModule: true
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("2c", ["3c", "3d"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  require("3c");
  module.exports = require("3d").Object.keys;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("2e", ["3e"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  module.exports = require("3e");
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("2d", ["3f", "40"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var iota = require("3f");
  var isBuffer = require("40");
  var hasTypedArrays = ((typeof Float64Array) !== "undefined");
  function compare1st(a, b) {
    return a[0] - b[0];
  }
  function order() {
    var stride = this.stride;
    var terms = new Array(stride.length);
    var i;
    for (i = 0; i < terms.length; ++i) {
      terms[i] = [Math.abs(stride[i]), i];
    }
    terms.sort(compare1st);
    var result = new Array(terms.length);
    for (i = 0; i < result.length; ++i) {
      result[i] = terms[i][1];
    }
    return result;
  }
  function compileConstructor(dtype, dimension) {
    var className = ["View", dimension, "d", dtype].join("");
    if (dimension < 0) {
      className = "View_Nil" + dtype;
    }
    var useGetters = (dtype === "generic");
    if (dimension === -1) {
      var code = "function " + className + "(a){this.data=a;};\
var proto=" + className + ".prototype;\
proto.dtype='" + dtype + "';\
proto.index=function(){return -1};\
proto.size=0;\
proto.dimension=-1;\
proto.shape=proto.stride=proto.order=[];\
proto.lo=proto.hi=proto.transpose=proto.step=\
function(){return new " + className + "(this.data);};\
proto.get=proto.set=function(){};\
proto.pick=function(){return null};\
return function construct_" + className + "(a){return new " + className + "(a);}";
      var procedure = new Function(code);
      return procedure();
    } else if (dimension === 0) {
      var code = "function " + className + "(a,d) {\
this.data = a;\
this.offset = d\
};\
var proto=" + className + ".prototype;\
proto.dtype='" + dtype + "';\
proto.index=function(){return this.offset};\
proto.dimension=0;\
proto.size=1;\
proto.shape=\
proto.stride=\
proto.order=[];\
proto.lo=\
proto.hi=\
proto.transpose=\
proto.step=function " + className + "_copy() {\
return new " + className + "(this.data,this.offset)\
};\
proto.pick=function " + className + "_pick(){\
return TrivialArray(this.data);\
};\
proto.valueOf=proto.get=function " + className + "_get(){\
return " + (useGetters ? "this.data.get(this.offset)" : "this.data[this.offset]") + "};\
proto.set=function " + className + "_set(v){\
return " + (useGetters ? "this.data.set(this.offset,v)" : "this.data[this.offset]=v") + "\
};\
return function construct_" + className + "(a,b,c,d){return new " + className + "(a,d)}";
      var procedure = new Function("TrivialArray", code);
      return procedure(CACHED_CONSTRUCTORS[dtype][0]);
    }
    var code = ["'use strict'"];
    var indices = iota(dimension);
    var args = indices.map(function(i) {
      return "i" + i;
    });
    var index_str = "this.offset+" + indices.map(function(i) {
      return "this.stride[" + i + "]*i" + i;
    }).join("+");
    var shapeArg = indices.map(function(i) {
      return "b" + i;
    }).join(",");
    var strideArg = indices.map(function(i) {
      return "c" + i;
    }).join(",");
    code.push("function " + className + "(a," + shapeArg + "," + strideArg + ",d){this.data=a", "this.shape=[" + shapeArg + "]", "this.stride=[" + strideArg + "]", "this.offset=d|0}", "var proto=" + className + ".prototype", "proto.dtype='" + dtype + "'", "proto.dimension=" + dimension);
    code.push("Object.defineProperty(proto,'size',{get:function " + className + "_size(){\
return " + indices.map(function(i) {
      return "this.shape[" + i + "]";
    }).join("*"), "}})");
    if (dimension === 1) {
      code.push("proto.order=[0]");
    } else {
      code.push("Object.defineProperty(proto,'order',{get:");
      if (dimension < 4) {
        code.push("function " + className + "_order(){");
        if (dimension === 2) {
          code.push("return (Math.abs(this.stride[0])>Math.abs(this.stride[1]))?[1,0]:[0,1]}})");
        } else if (dimension === 3) {
          code.push("var s0=Math.abs(this.stride[0]),s1=Math.abs(this.stride[1]),s2=Math.abs(this.stride[2]);\
if(s0>s1){\
if(s1>s2){\
return [2,1,0];\
}else if(s0>s2){\
return [1,2,0];\
}else{\
return [1,0,2];\
}\
}else if(s0>s2){\
return [2,0,1];\
}else if(s2>s1){\
return [0,1,2];\
}else{\
return [0,2,1];\
}}})");
        }
      } else {
        code.push("ORDER})");
      }
    }
    code.push("proto.set=function " + className + "_set(" + args.join(",") + ",v){");
    if (useGetters) {
      code.push("return this.data.set(" + index_str + ",v)}");
    } else {
      code.push("return this.data[" + index_str + "]=v}");
    }
    code.push("proto.get=function " + className + "_get(" + args.join(",") + "){");
    if (useGetters) {
      code.push("return this.data.get(" + index_str + ")}");
    } else {
      code.push("return this.data[" + index_str + "]}");
    }
    code.push("proto.index=function " + className + "_index(", args.join(), "){return " + index_str + "}");
    code.push("proto.hi=function " + className + "_hi(" + args.join(",") + "){return new " + className + "(this.data," + indices.map(function(i) {
      return ["(typeof i", i, "!=='number'||i", i, "<0)?this.shape[", i, "]:i", i, "|0"].join("");
    }).join(",") + "," + indices.map(function(i) {
      return "this.stride[" + i + "]";
    }).join(",") + ",this.offset)}");
    var a_vars = indices.map(function(i) {
      return "a" + i + "=this.shape[" + i + "]";
    });
    var c_vars = indices.map(function(i) {
      return "c" + i + "=this.stride[" + i + "]";
    });
    code.push("proto.lo=function " + className + "_lo(" + args.join(",") + "){var b=this.offset,d=0," + a_vars.join(",") + "," + c_vars.join(","));
    for (var i = 0; i < dimension; ++i) {
      code.push("if(typeof i" + i + "==='number'&&i" + i + ">=0){\
d=i" + i + "|0;\
b+=c" + i + "*d;\
a" + i + "-=d}");
    }
    code.push("return new " + className + "(this.data," + indices.map(function(i) {
      return "a" + i;
    }).join(",") + "," + indices.map(function(i) {
      return "c" + i;
    }).join(",") + ",b)}");
    code.push("proto.step=function " + className + "_step(" + args.join(",") + "){var " + indices.map(function(i) {
      return "a" + i + "=this.shape[" + i + "]";
    }).join(",") + "," + indices.map(function(i) {
      return "b" + i + "=this.stride[" + i + "]";
    }).join(",") + ",c=this.offset,d=0,ceil=Math.ceil");
    for (var i = 0; i < dimension; ++i) {
      code.push("if(typeof i" + i + "==='number'){\
d=i" + i + "|0;\
if(d<0){\
c+=b" + i + "*(a" + i + "-1);\
a" + i + "=ceil(-a" + i + "/d)\
}else{\
a" + i + "=ceil(a" + i + "/d)\
}\
b" + i + "*=d\
}");
    }
    code.push("return new " + className + "(this.data," + indices.map(function(i) {
      return "a" + i;
    }).join(",") + "," + indices.map(function(i) {
      return "b" + i;
    }).join(",") + ",c)}");
    var tShape = new Array(dimension);
    var tStride = new Array(dimension);
    for (var i = 0; i < dimension; ++i) {
      tShape[i] = "a[i" + i + "]";
      tStride[i] = "b[i" + i + "]";
    }
    code.push("proto.transpose=function " + className + "_transpose(" + args + "){" + args.map(function(n, idx) {
      return n + "=(" + n + "===undefined?" + idx + ":" + n + "|0)";
    }).join(";"), "var a=this.shape,b=this.stride;return new " + className + "(this.data," + tShape.join(",") + "," + tStride.join(",") + ",this.offset)}");
    code.push("proto.pick=function " + className + "_pick(" + args + "){var a=[],b=[],c=this.offset");
    for (var i = 0; i < dimension; ++i) {
      code.push("if(typeof i" + i + "==='number'&&i" + i + ">=0){c=(c+this.stride[" + i + "]*i" + i + ")|0}else{a.push(this.shape[" + i + "]);b.push(this.stride[" + i + "])}");
    }
    code.push("var ctor=CTOR_LIST[a.length+1];return ctor(this.data,a,b,c)}");
    code.push("return function construct_" + className + "(data,shape,stride,offset){return new " + className + "(data," + indices.map(function(i) {
      return "shape[" + i + "]";
    }).join(",") + "," + indices.map(function(i) {
      return "stride[" + i + "]";
    }).join(",") + ",offset)}");
    var procedure = new Function("CTOR_LIST", "ORDER", code.join("\n"));
    return procedure(CACHED_CONSTRUCTORS[dtype], order);
  }
  function arrayDType(data) {
    if (isBuffer(data)) {
      return "buffer";
    }
    if (hasTypedArrays) {
      switch (Object.prototype.toString.call(data)) {
        case "[object Float64Array]":
          return "float64";
        case "[object Float32Array]":
          return "float32";
        case "[object Int8Array]":
          return "int8";
        case "[object Int16Array]":
          return "int16";
        case "[object Int32Array]":
          return "int32";
        case "[object Uint8Array]":
          return "uint8";
        case "[object Uint16Array]":
          return "uint16";
        case "[object Uint32Array]":
          return "uint32";
        case "[object Uint8ClampedArray]":
          return "uint8_clamped";
      }
    }
    if (Array.isArray(data)) {
      return "array";
    }
    return "generic";
  }
  var CACHED_CONSTRUCTORS = {
    "float32": [],
    "float64": [],
    "int8": [],
    "int16": [],
    "int32": [],
    "uint8": [],
    "uint16": [],
    "uint32": [],
    "array": [],
    "uint8_clamped": [],
    "buffer": [],
    "generic": []
  };
  ;
  (function() {
    for (var id in CACHED_CONSTRUCTORS) {
      CACHED_CONSTRUCTORS[id].push(compileConstructor(id, -1));
    }
  });
  function wrappedNDArrayCtor(data, shape, stride, offset) {
    if (data === undefined) {
      var ctor = CACHED_CONSTRUCTORS.array[0];
      return ctor([]);
    } else if (typeof data === "number") {
      data = [data];
    }
    if (shape === undefined) {
      shape = [data.length];
    }
    var d = shape.length;
    if (stride === undefined) {
      stride = new Array(d);
      for (var i = d - 1,
          sz = 1; i >= 0; --i) {
        stride[i] = sz;
        sz *= shape[i];
      }
    }
    if (offset === undefined) {
      offset = 0;
      for (var i = 0; i < d; ++i) {
        if (stride[i] < 0) {
          offset -= (shape[i] - 1) * stride[i];
        }
      }
    }
    var dtype = arrayDType(data);
    var ctor_list = CACHED_CONSTRUCTORS[dtype];
    while (ctor_list.length <= d + 1) {
      ctor_list.push(compileConstructor(dtype, ctor_list.length - 1));
    }
    var ctor = ctor_list[d + 1];
    return ctor(data, shape, stride, offset);
  }
  module.exports = wrappedNDArrayCtor;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("2f", ["41", "42", "43", "44", "3d"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  require("41");
  require("42");
  require("43");
  require("44");
  module.exports = require("3d").Promise;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("31", ["41", "42", "43", "45", "46", "3d"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  require("41");
  require("42");
  require("43");
  require("45");
  require("46");
  module.exports = require("3d").Map;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("30", ["43", "42", "47"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  require("43");
  require("42");
  module.exports = require("47");
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("32", ["48", "3d"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  require("48");
  module.exports = require("3d").Math.trunc;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("33", ["49"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  "format cjs";
  (function(process) {
    (function webpackUniversalModuleDefinition(root, factory) {
      if (typeof exports === 'object' && typeof module === 'object')
        module.exports = factory();
      else if (typeof define === 'function' && define.amd)
        define([], factory);
      else if (typeof exports === 'object')
        exports["wu"] = factory();
      else
        root["wu"] = factory();
    })(this, function() {
      return (function(modules) {
        var installedModules = {};
        function __webpack_require__(moduleId) {
          if (installedModules[moduleId])
            return installedModules[moduleId].exports;
          var module = installedModules[moduleId] = {
            exports: {},
            id: moduleId,
            loaded: false
          };
          modules[moduleId].call(module.exports, module, module.exports, __webpack_require__);
          module.loaded = true;
          return module.exports;
        }
        __webpack_require__.m = modules;
        __webpack_require__.c = installedModules;
        __webpack_require__.p = "";
        return __webpack_require__(0);
      })([function(module, exports, __webpack_require__) {
        "use strict";
        var _toConsumableArray = __webpack_require__(1)["default"];
        var _slicedToArray = __webpack_require__(39)["default"];
        var _Symbol$iterator = __webpack_require__(52)["default"];
        var _getIterator = __webpack_require__(40)["default"];
        var _regeneratorRuntime = __webpack_require__(54)["default"];
        var _Object$keys = __webpack_require__(80)["default"];
        var _Set = __webpack_require__(84)["default"];
        var _Promise = __webpack_require__(65)["default"];
        var wu = module.exports = function wu(iterable) {
          if (!isIterable(iterable)) {
            throw new Error("wu: `" + iterable + "` is not iterable!");
          }
          return new Wu(iterable);
        };
        function Wu(iterable) {
          var iterator = getIterator(iterable);
          this.next = iterator.next.bind(iterator);
        }
        wu.prototype = Wu.prototype;
        wu.prototype[_Symbol$iterator] = function() {
          return this;
        };
        var MISSING = {};
        var isIterable = function isIterable(thing) {
          return thing && typeof thing[_Symbol$iterator] === "function";
        };
        var getIterator = function getIterator(thing) {
          if (isIterable(thing)) {
            return _getIterator(thing);
          }
          throw new TypeError("Not iterable: " + thing);
        };
        var staticMethod = function staticMethod(name, fn) {
          fn.prototype = Wu.prototype;
          wu[name] = fn;
        };
        var prototypeAndStatic = function prototypeAndStatic(name, fn) {
          var expectedArgs = arguments.length <= 2 || arguments[2] === undefined ? fn.length : arguments[2];
          return (function() {
            fn.prototype = Wu.prototype;
            Wu.prototype[name] = fn;
            expectedArgs += 1;
            wu[name] = wu.curryable(function() {
              var _wu;
              for (var _len = arguments.length,
                  args = Array(_len),
                  _key = 0; _key < _len; _key++) {
                args[_key] = arguments[_key];
              }
              var iterable = args.pop();
              return (_wu = wu(iterable))[name].apply(_wu, args);
            }, expectedArgs);
          })();
        };
        var rewrap = function rewrap(fn) {
          return function() {
            for (var _len2 = arguments.length,
                args = Array(_len2),
                _key2 = 0; _key2 < _len2; _key2++) {
              args[_key2] = arguments[_key2];
            }
            return wu(fn.call.apply(fn, [this].concat(args)));
          };
        };
        var rewrapStaticMethod = function rewrapStaticMethod(name, fn) {
          return staticMethod(name, rewrap(fn));
        };
        var rewrapPrototypeAndStatic = function rewrapPrototypeAndStatic(name, fn, expectedArgs) {
          return prototypeAndStatic(name, rewrap(fn), expectedArgs);
        };
        function curry(fn, args) {
          return function() {
            for (var _len3 = arguments.length,
                moreArgs = Array(_len3),
                _key3 = 0; _key3 < _len3; _key3++) {
              moreArgs[_key3] = arguments[_key3];
            }
            return fn.call.apply(fn, [this].concat(_toConsumableArray(args), moreArgs));
          };
        }
        staticMethod("curryable", function(fn) {
          var expected = arguments.length <= 1 || arguments[1] === undefined ? fn.length : arguments[1];
          return (function() {
            return function f() {
              for (var _len4 = arguments.length,
                  args = Array(_len4),
                  _key4 = 0; _key4 < _len4; _key4++) {
                args[_key4] = arguments[_key4];
              }
              return args.length >= expected ? fn.apply(this, args) : curry(f, args);
            };
          })();
        });
        rewrapStaticMethod("entries", _regeneratorRuntime.mark(function callee$0$0(obj) {
          var _iteratorNormalCompletion,
              _didIteratorError,
              _iteratorError,
              _iterator,
              _step,
              k;
          return _regeneratorRuntime.wrap(function callee$0$0$(context$1$0) {
            while (1)
              switch (context$1$0.prev = context$1$0.next) {
                case 0:
                  _iteratorNormalCompletion = true;
                  _didIteratorError = false;
                  _iteratorError = undefined;
                  context$1$0.prev = 3;
                  _iterator = _getIterator(_Object$keys(obj));
                case 5:
                  if (_iteratorNormalCompletion = (_step = _iterator.next()).done) {
                    context$1$0.next = 12;
                    break;
                  }
                  k = _step.value;
                  context$1$0.next = 9;
                  return [k, obj[k]];
                case 9:
                  _iteratorNormalCompletion = true;
                  context$1$0.next = 5;
                  break;
                case 12:
                  context$1$0.next = 18;
                  break;
                case 14:
                  context$1$0.prev = 14;
                  context$1$0.t0 = context$1$0["catch"](3);
                  _didIteratorError = true;
                  _iteratorError = context$1$0.t0;
                case 18:
                  context$1$0.prev = 18;
                  context$1$0.prev = 19;
                  if (!_iteratorNormalCompletion && _iterator["return"]) {
                    _iterator["return"]();
                  }
                case 21:
                  context$1$0.prev = 21;
                  if (!_didIteratorError) {
                    context$1$0.next = 24;
                    break;
                  }
                  throw _iteratorError;
                case 24:
                  return context$1$0.finish(21);
                case 25:
                  return context$1$0.finish(18);
                case 26:
                case "end":
                  return context$1$0.stop();
              }
          }, callee$0$0, this, [[3, 14, 18, 26], [19, , 21, 25]]);
        }));
        rewrapStaticMethod("keys", _regeneratorRuntime.mark(function callee$0$0(obj) {
          return _regeneratorRuntime.wrap(function callee$0$0$(context$1$0) {
            while (1)
              switch (context$1$0.prev = context$1$0.next) {
                case 0:
                  return context$1$0.delegateYield(_Object$keys(obj), "t0", 1);
                case 1:
                case "end":
                  return context$1$0.stop();
              }
          }, callee$0$0, this);
        }));
        rewrapStaticMethod("values", _regeneratorRuntime.mark(function callee$0$0(obj) {
          var _iteratorNormalCompletion2,
              _didIteratorError2,
              _iteratorError2,
              _iterator2,
              _step2,
              k;
          return _regeneratorRuntime.wrap(function callee$0$0$(context$1$0) {
            while (1)
              switch (context$1$0.prev = context$1$0.next) {
                case 0:
                  _iteratorNormalCompletion2 = true;
                  _didIteratorError2 = false;
                  _iteratorError2 = undefined;
                  context$1$0.prev = 3;
                  _iterator2 = _getIterator(_Object$keys(obj));
                case 5:
                  if (_iteratorNormalCompletion2 = (_step2 = _iterator2.next()).done) {
                    context$1$0.next = 12;
                    break;
                  }
                  k = _step2.value;
                  context$1$0.next = 9;
                  return obj[k];
                case 9:
                  _iteratorNormalCompletion2 = true;
                  context$1$0.next = 5;
                  break;
                case 12:
                  context$1$0.next = 18;
                  break;
                case 14:
                  context$1$0.prev = 14;
                  context$1$0.t0 = context$1$0["catch"](3);
                  _didIteratorError2 = true;
                  _iteratorError2 = context$1$0.t0;
                case 18:
                  context$1$0.prev = 18;
                  context$1$0.prev = 19;
                  if (!_iteratorNormalCompletion2 && _iterator2["return"]) {
                    _iterator2["return"]();
                  }
                case 21:
                  context$1$0.prev = 21;
                  if (!_didIteratorError2) {
                    context$1$0.next = 24;
                    break;
                  }
                  throw _iteratorError2;
                case 24:
                  return context$1$0.finish(21);
                case 25:
                  return context$1$0.finish(18);
                case 26:
                case "end":
                  return context$1$0.stop();
              }
          }, callee$0$0, this, [[3, 14, 18, 26], [19, , 21, 25]]);
        }));
        rewrapPrototypeAndStatic("cycle", _regeneratorRuntime.mark(function callee$0$0() {
          var saved,
              _iteratorNormalCompletion3,
              _didIteratorError3,
              _iteratorError3,
              _iterator3,
              _step3,
              x;
          return _regeneratorRuntime.wrap(function callee$0$0$(context$1$0) {
            while (1)
              switch (context$1$0.prev = context$1$0.next) {
                case 0:
                  saved = [];
                  _iteratorNormalCompletion3 = true;
                  _didIteratorError3 = false;
                  _iteratorError3 = undefined;
                  context$1$0.prev = 4;
                  _iterator3 = _getIterator(this);
                case 6:
                  if (_iteratorNormalCompletion3 = (_step3 = _iterator3.next()).done) {
                    context$1$0.next = 14;
                    break;
                  }
                  x = _step3.value;
                  context$1$0.next = 10;
                  return x;
                case 10:
                  saved.push(x);
                case 11:
                  _iteratorNormalCompletion3 = true;
                  context$1$0.next = 6;
                  break;
                case 14:
                  context$1$0.next = 20;
                  break;
                case 16:
                  context$1$0.prev = 16;
                  context$1$0.t0 = context$1$0["catch"](4);
                  _didIteratorError3 = true;
                  _iteratorError3 = context$1$0.t0;
                case 20:
                  context$1$0.prev = 20;
                  context$1$0.prev = 21;
                  if (!_iteratorNormalCompletion3 && _iterator3["return"]) {
                    _iterator3["return"]();
                  }
                case 23:
                  context$1$0.prev = 23;
                  if (!_didIteratorError3) {
                    context$1$0.next = 26;
                    break;
                  }
                  throw _iteratorError3;
                case 26:
                  return context$1$0.finish(23);
                case 27:
                  return context$1$0.finish(20);
                case 28:
                  if (!saved) {
                    context$1$0.next = 32;
                    break;
                  }
                  return context$1$0.delegateYield(saved, "t1", 30);
                case 30:
                  context$1$0.next = 28;
                  break;
                case 32:
                case "end":
                  return context$1$0.stop();
              }
          }, callee$0$0, this, [[4, 16, 20, 28], [21, , 23, 27]]);
        }));
        rewrapStaticMethod("count", _regeneratorRuntime.mark(function callee$0$0() {
          var start = arguments.length <= 0 || arguments[0] === undefined ? 0 : arguments[0];
          var step = arguments.length <= 1 || arguments[1] === undefined ? 1 : arguments[1];
          var n;
          return _regeneratorRuntime.wrap(function callee$0$0$(context$1$0) {
            while (1)
              switch (context$1$0.prev = context$1$0.next) {
                case 0:
                  n = start;
                case 1:
                  if (false) {
                    context$1$0.next = 7;
                    break;
                  }
                  context$1$0.next = 4;
                  return n;
                case 4:
                  n += step;
                  context$1$0.next = 1;
                  break;
                case 7:
                case "end":
                  return context$1$0.stop();
              }
          }, callee$0$0, this);
        }));
        rewrapStaticMethod("repeat", _regeneratorRuntime.mark(function callee$0$0(thing) {
          var times = arguments.length <= 1 || arguments[1] === undefined ? Infinity : arguments[1];
          var i;
          return _regeneratorRuntime.wrap(function callee$0$0$(context$1$0) {
            while (1)
              switch (context$1$0.prev = context$1$0.next) {
                case 0:
                  if (!(times === Infinity)) {
                    context$1$0.next = 8;
                    break;
                  }
                case 1:
                  if (false) {
                    context$1$0.next = 6;
                    break;
                  }
                  context$1$0.next = 4;
                  return thing;
                case 4:
                  context$1$0.next = 1;
                  break;
                case 6:
                  context$1$0.next = 15;
                  break;
                case 8:
                  i = 0;
                case 9:
                  if (!(i < times)) {
                    context$1$0.next = 15;
                    break;
                  }
                  context$1$0.next = 12;
                  return thing;
                case 12:
                  i++;
                  context$1$0.next = 9;
                  break;
                case 15:
                case "end":
                  return context$1$0.stop();
              }
          }, callee$0$0, this);
        }));
        rewrapStaticMethod("chain", _regeneratorRuntime.mark(function callee$0$0() {
          var _iteratorNormalCompletion4,
              _didIteratorError4,
              _iteratorError4,
              _len5,
              iterables,
              _key5,
              _iterator4,
              _step4,
              it,
              args$1$0 = arguments;
          return _regeneratorRuntime.wrap(function callee$0$0$(context$1$0) {
            while (1)
              switch (context$1$0.prev = context$1$0.next) {
                case 0:
                  _iteratorNormalCompletion4 = true;
                  _didIteratorError4 = false;
                  _iteratorError4 = undefined;
                  context$1$0.prev = 3;
                  for (_len5 = args$1$0.length, iterables = Array(_len5), _key5 = 0; _key5 < _len5; _key5++) {
                    iterables[_key5] = args$1$0[_key5];
                  }
                  _iterator4 = _getIterator(iterables);
                case 6:
                  if (_iteratorNormalCompletion4 = (_step4 = _iterator4.next()).done) {
                    context$1$0.next = 12;
                    break;
                  }
                  it = _step4.value;
                  return context$1$0.delegateYield(it, "t0", 9);
                case 9:
                  _iteratorNormalCompletion4 = true;
                  context$1$0.next = 6;
                  break;
                case 12:
                  context$1$0.next = 18;
                  break;
                case 14:
                  context$1$0.prev = 14;
                  context$1$0.t1 = context$1$0["catch"](3);
                  _didIteratorError4 = true;
                  _iteratorError4 = context$1$0.t1;
                case 18:
                  context$1$0.prev = 18;
                  context$1$0.prev = 19;
                  if (!_iteratorNormalCompletion4 && _iterator4["return"]) {
                    _iterator4["return"]();
                  }
                case 21:
                  context$1$0.prev = 21;
                  if (!_didIteratorError4) {
                    context$1$0.next = 24;
                    break;
                  }
                  throw _iteratorError4;
                case 24:
                  return context$1$0.finish(21);
                case 25:
                  return context$1$0.finish(18);
                case 26:
                case "end":
                  return context$1$0.stop();
              }
          }, callee$0$0, this, [[3, 14, 18, 26], [19, , 21, 25]]);
        }));
        rewrapPrototypeAndStatic("chunk", _regeneratorRuntime.mark(function callee$0$0() {
          var n = arguments.length <= 0 || arguments[0] === undefined ? 2 : arguments[0];
          var items,
              index,
              _iteratorNormalCompletion5,
              _didIteratorError5,
              _iteratorError5,
              _iterator5,
              _step5,
              item;
          return _regeneratorRuntime.wrap(function callee$0$0$(context$1$0) {
            while (1)
              switch (context$1$0.prev = context$1$0.next) {
                case 0:
                  items = [];
                  index = 0;
                  _iteratorNormalCompletion5 = true;
                  _didIteratorError5 = false;
                  _iteratorError5 = undefined;
                  context$1$0.prev = 5;
                  _iterator5 = _getIterator(this);
                case 7:
                  if (_iteratorNormalCompletion5 = (_step5 = _iterator5.next()).done) {
                    context$1$0.next = 18;
                    break;
                  }
                  item = _step5.value;
                  items[index++] = item;
                  if (!(index === n)) {
                    context$1$0.next = 15;
                    break;
                  }
                  context$1$0.next = 13;
                  return items;
                case 13:
                  items = [];
                  index = 0;
                case 15:
                  _iteratorNormalCompletion5 = true;
                  context$1$0.next = 7;
                  break;
                case 18:
                  context$1$0.next = 24;
                  break;
                case 20:
                  context$1$0.prev = 20;
                  context$1$0.t0 = context$1$0["catch"](5);
                  _didIteratorError5 = true;
                  _iteratorError5 = context$1$0.t0;
                case 24:
                  context$1$0.prev = 24;
                  context$1$0.prev = 25;
                  if (!_iteratorNormalCompletion5 && _iterator5["return"]) {
                    _iterator5["return"]();
                  }
                case 27:
                  context$1$0.prev = 27;
                  if (!_didIteratorError5) {
                    context$1$0.next = 30;
                    break;
                  }
                  throw _iteratorError5;
                case 30:
                  return context$1$0.finish(27);
                case 31:
                  return context$1$0.finish(24);
                case 32:
                  if (!index) {
                    context$1$0.next = 35;
                    break;
                  }
                  context$1$0.next = 35;
                  return items;
                case 35:
                case "end":
                  return context$1$0.stop();
              }
          }, callee$0$0, this, [[5, 20, 24, 32], [25, , 27, 31]]);
        }), 1);
        rewrapPrototypeAndStatic("concatMap", _regeneratorRuntime.mark(function callee$0$0(fn) {
          var _iteratorNormalCompletion6,
              _didIteratorError6,
              _iteratorError6,
              _iterator6,
              _step6,
              x;
          return _regeneratorRuntime.wrap(function callee$0$0$(context$1$0) {
            while (1)
              switch (context$1$0.prev = context$1$0.next) {
                case 0:
                  _iteratorNormalCompletion6 = true;
                  _didIteratorError6 = false;
                  _iteratorError6 = undefined;
                  context$1$0.prev = 3;
                  _iterator6 = _getIterator(this);
                case 5:
                  if (_iteratorNormalCompletion6 = (_step6 = _iterator6.next()).done) {
                    context$1$0.next = 11;
                    break;
                  }
                  x = _step6.value;
                  return context$1$0.delegateYield(fn(x), "t0", 8);
                case 8:
                  _iteratorNormalCompletion6 = true;
                  context$1$0.next = 5;
                  break;
                case 11:
                  context$1$0.next = 17;
                  break;
                case 13:
                  context$1$0.prev = 13;
                  context$1$0.t1 = context$1$0["catch"](3);
                  _didIteratorError6 = true;
                  _iteratorError6 = context$1$0.t1;
                case 17:
                  context$1$0.prev = 17;
                  context$1$0.prev = 18;
                  if (!_iteratorNormalCompletion6 && _iterator6["return"]) {
                    _iterator6["return"]();
                  }
                case 20:
                  context$1$0.prev = 20;
                  if (!_didIteratorError6) {
                    context$1$0.next = 23;
                    break;
                  }
                  throw _iteratorError6;
                case 23:
                  return context$1$0.finish(20);
                case 24:
                  return context$1$0.finish(17);
                case 25:
                case "end":
                  return context$1$0.stop();
              }
          }, callee$0$0, this, [[3, 13, 17, 25], [18, , 20, 24]]);
        }));
        rewrapPrototypeAndStatic("drop", _regeneratorRuntime.mark(function callee$0$0(n) {
          var i,
              _iteratorNormalCompletion7,
              _didIteratorError7,
              _iteratorError7,
              _iterator7,
              _step7,
              x;
          return _regeneratorRuntime.wrap(function callee$0$0$(context$1$0) {
            while (1)
              switch (context$1$0.prev = context$1$0.next) {
                case 0:
                  i = 0;
                  _iteratorNormalCompletion7 = true;
                  _didIteratorError7 = false;
                  _iteratorError7 = undefined;
                  context$1$0.prev = 4;
                  _iterator7 = _getIterator(this);
                case 6:
                  if (_iteratorNormalCompletion7 = (_step7 = _iterator7.next()).done) {
                    context$1$0.next = 16;
                    break;
                  }
                  x = _step7.value;
                  if (!(i++ < n)) {
                    context$1$0.next = 10;
                    break;
                  }
                  return context$1$0.abrupt("continue", 13);
                case 10:
                  context$1$0.next = 12;
                  return x;
                case 12:
                  return context$1$0.abrupt("break", 16);
                case 13:
                  _iteratorNormalCompletion7 = true;
                  context$1$0.next = 6;
                  break;
                case 16:
                  context$1$0.next = 22;
                  break;
                case 18:
                  context$1$0.prev = 18;
                  context$1$0.t0 = context$1$0["catch"](4);
                  _didIteratorError7 = true;
                  _iteratorError7 = context$1$0.t0;
                case 22:
                  context$1$0.prev = 22;
                  context$1$0.prev = 23;
                  if (!_iteratorNormalCompletion7 && _iterator7["return"]) {
                    _iterator7["return"]();
                  }
                case 25:
                  context$1$0.prev = 25;
                  if (!_didIteratorError7) {
                    context$1$0.next = 28;
                    break;
                  }
                  throw _iteratorError7;
                case 28:
                  return context$1$0.finish(25);
                case 29:
                  return context$1$0.finish(22);
                case 30:
                  return context$1$0.delegateYield(this, "t1", 31);
                case 31:
                case "end":
                  return context$1$0.stop();
              }
          }, callee$0$0, this, [[4, 18, 22, 30], [23, , 25, 29]]);
        }));
        rewrapPrototypeAndStatic("dropWhile", _regeneratorRuntime.mark(function callee$0$0() {
          var fn = arguments.length <= 0 || arguments[0] === undefined ? Boolean : arguments[0];
          var _iteratorNormalCompletion8,
              _didIteratorError8,
              _iteratorError8,
              _iterator8,
              _step8,
              x;
          return _regeneratorRuntime.wrap(function callee$0$0$(context$1$0) {
            while (1)
              switch (context$1$0.prev = context$1$0.next) {
                case 0:
                  _iteratorNormalCompletion8 = true;
                  _didIteratorError8 = false;
                  _iteratorError8 = undefined;
                  context$1$0.prev = 3;
                  _iterator8 = _getIterator(this);
                case 5:
                  if (_iteratorNormalCompletion8 = (_step8 = _iterator8.next()).done) {
                    context$1$0.next = 15;
                    break;
                  }
                  x = _step8.value;
                  if (!fn(x)) {
                    context$1$0.next = 9;
                    break;
                  }
                  return context$1$0.abrupt("continue", 12);
                case 9:
                  context$1$0.next = 11;
                  return x;
                case 11:
                  return context$1$0.abrupt("break", 15);
                case 12:
                  _iteratorNormalCompletion8 = true;
                  context$1$0.next = 5;
                  break;
                case 15:
                  context$1$0.next = 21;
                  break;
                case 17:
                  context$1$0.prev = 17;
                  context$1$0.t0 = context$1$0["catch"](3);
                  _didIteratorError8 = true;
                  _iteratorError8 = context$1$0.t0;
                case 21:
                  context$1$0.prev = 21;
                  context$1$0.prev = 22;
                  if (!_iteratorNormalCompletion8 && _iterator8["return"]) {
                    _iterator8["return"]();
                  }
                case 24:
                  context$1$0.prev = 24;
                  if (!_didIteratorError8) {
                    context$1$0.next = 27;
                    break;
                  }
                  throw _iteratorError8;
                case 27:
                  return context$1$0.finish(24);
                case 28:
                  return context$1$0.finish(21);
                case 29:
                  return context$1$0.delegateYield(this, "t1", 30);
                case 30:
                case "end":
                  return context$1$0.stop();
              }
          }, callee$0$0, this, [[3, 17, 21, 29], [22, , 24, 28]]);
        }), 1);
        rewrapPrototypeAndStatic("enumerate", _regeneratorRuntime.mark(function callee$0$0() {
          return _regeneratorRuntime.wrap(function callee$0$0$(context$1$0) {
            while (1)
              switch (context$1$0.prev = context$1$0.next) {
                case 0:
                  return context$1$0.delegateYield(_zip([this, wu.count()]), "t0", 1);
                case 1:
                case "end":
                  return context$1$0.stop();
              }
          }, callee$0$0, this);
        }));
        rewrapPrototypeAndStatic("filter", _regeneratorRuntime.mark(function callee$0$0() {
          var fn = arguments.length <= 0 || arguments[0] === undefined ? Boolean : arguments[0];
          var _iteratorNormalCompletion9,
              _didIteratorError9,
              _iteratorError9,
              _iterator9,
              _step9,
              x;
          return _regeneratorRuntime.wrap(function callee$0$0$(context$1$0) {
            while (1)
              switch (context$1$0.prev = context$1$0.next) {
                case 0:
                  _iteratorNormalCompletion9 = true;
                  _didIteratorError9 = false;
                  _iteratorError9 = undefined;
                  context$1$0.prev = 3;
                  _iterator9 = _getIterator(this);
                case 5:
                  if (_iteratorNormalCompletion9 = (_step9 = _iterator9.next()).done) {
                    context$1$0.next = 13;
                    break;
                  }
                  x = _step9.value;
                  if (!fn(x)) {
                    context$1$0.next = 10;
                    break;
                  }
                  context$1$0.next = 10;
                  return x;
                case 10:
                  _iteratorNormalCompletion9 = true;
                  context$1$0.next = 5;
                  break;
                case 13:
                  context$1$0.next = 19;
                  break;
                case 15:
                  context$1$0.prev = 15;
                  context$1$0.t0 = context$1$0["catch"](3);
                  _didIteratorError9 = true;
                  _iteratorError9 = context$1$0.t0;
                case 19:
                  context$1$0.prev = 19;
                  context$1$0.prev = 20;
                  if (!_iteratorNormalCompletion9 && _iterator9["return"]) {
                    _iterator9["return"]();
                  }
                case 22:
                  context$1$0.prev = 22;
                  if (!_didIteratorError9) {
                    context$1$0.next = 25;
                    break;
                  }
                  throw _iteratorError9;
                case 25:
                  return context$1$0.finish(22);
                case 26:
                  return context$1$0.finish(19);
                case 27:
                case "end":
                  return context$1$0.stop();
              }
          }, callee$0$0, this, [[3, 15, 19, 27], [20, , 22, 26]]);
        }), 1);
        rewrapPrototypeAndStatic("flatten", _regeneratorRuntime.mark(function callee$0$0() {
          var shallow = arguments.length <= 0 || arguments[0] === undefined ? false : arguments[0];
          var _iteratorNormalCompletion10,
              _didIteratorError10,
              _iteratorError10,
              _iterator10,
              _step10,
              x;
          return _regeneratorRuntime.wrap(function callee$0$0$(context$1$0) {
            while (1)
              switch (context$1$0.prev = context$1$0.next) {
                case 0:
                  _iteratorNormalCompletion10 = true;
                  _didIteratorError10 = false;
                  _iteratorError10 = undefined;
                  context$1$0.prev = 3;
                  _iterator10 = _getIterator(this);
                case 5:
                  if (_iteratorNormalCompletion10 = (_step10 = _iterator10.next()).done) {
                    context$1$0.next = 16;
                    break;
                  }
                  x = _step10.value;
                  if (!(typeof x !== "string" && isIterable(x))) {
                    context$1$0.next = 11;
                    break;
                  }
                  return context$1$0.delegateYield(shallow ? x : wu(x).flatten(), "t0", 9);
                case 9:
                  context$1$0.next = 13;
                  break;
                case 11:
                  context$1$0.next = 13;
                  return x;
                case 13:
                  _iteratorNormalCompletion10 = true;
                  context$1$0.next = 5;
                  break;
                case 16:
                  context$1$0.next = 22;
                  break;
                case 18:
                  context$1$0.prev = 18;
                  context$1$0.t1 = context$1$0["catch"](3);
                  _didIteratorError10 = true;
                  _iteratorError10 = context$1$0.t1;
                case 22:
                  context$1$0.prev = 22;
                  context$1$0.prev = 23;
                  if (!_iteratorNormalCompletion10 && _iterator10["return"]) {
                    _iterator10["return"]();
                  }
                case 25:
                  context$1$0.prev = 25;
                  if (!_didIteratorError10) {
                    context$1$0.next = 28;
                    break;
                  }
                  throw _iteratorError10;
                case 28:
                  return context$1$0.finish(25);
                case 29:
                  return context$1$0.finish(22);
                case 30:
                case "end":
                  return context$1$0.stop();
              }
          }, callee$0$0, this, [[3, 18, 22, 30], [23, , 25, 29]]);
        }), 1);
        rewrapPrototypeAndStatic("invoke", _regeneratorRuntime.mark(function callee$0$0(name) {
          var _iteratorNormalCompletion11,
              _didIteratorError11,
              _iteratorError11,
              _len6,
              args,
              _key6,
              _iterator11,
              _step11,
              x,
              args$1$0 = arguments;
          return _regeneratorRuntime.wrap(function callee$0$0$(context$1$0) {
            while (1)
              switch (context$1$0.prev = context$1$0.next) {
                case 0:
                  _iteratorNormalCompletion11 = true;
                  _didIteratorError11 = false;
                  _iteratorError11 = undefined;
                  context$1$0.prev = 3;
                  for (_len6 = args$1$0.length, args = Array(_len6 > 1 ? _len6 - 1 : 0), _key6 = 1; _key6 < _len6; _key6++) {
                    args[_key6 - 1] = args$1$0[_key6];
                  }
                  _iterator11 = _getIterator(this);
                case 6:
                  if (_iteratorNormalCompletion11 = (_step11 = _iterator11.next()).done) {
                    context$1$0.next = 13;
                    break;
                  }
                  x = _step11.value;
                  context$1$0.next = 10;
                  return x[name].apply(x, args);
                case 10:
                  _iteratorNormalCompletion11 = true;
                  context$1$0.next = 6;
                  break;
                case 13:
                  context$1$0.next = 19;
                  break;
                case 15:
                  context$1$0.prev = 15;
                  context$1$0.t0 = context$1$0["catch"](3);
                  _didIteratorError11 = true;
                  _iteratorError11 = context$1$0.t0;
                case 19:
                  context$1$0.prev = 19;
                  context$1$0.prev = 20;
                  if (!_iteratorNormalCompletion11 && _iterator11["return"]) {
                    _iterator11["return"]();
                  }
                case 22:
                  context$1$0.prev = 22;
                  if (!_didIteratorError11) {
                    context$1$0.next = 25;
                    break;
                  }
                  throw _iteratorError11;
                case 25:
                  return context$1$0.finish(22);
                case 26:
                  return context$1$0.finish(19);
                case 27:
                case "end":
                  return context$1$0.stop();
              }
          }, callee$0$0, this, [[3, 15, 19, 27], [20, , 22, 26]]);
        }));
        rewrapPrototypeAndStatic("map", _regeneratorRuntime.mark(function callee$0$0(fn) {
          var _iteratorNormalCompletion12,
              _didIteratorError12,
              _iteratorError12,
              _iterator12,
              _step12,
              x;
          return _regeneratorRuntime.wrap(function callee$0$0$(context$1$0) {
            while (1)
              switch (context$1$0.prev = context$1$0.next) {
                case 0:
                  _iteratorNormalCompletion12 = true;
                  _didIteratorError12 = false;
                  _iteratorError12 = undefined;
                  context$1$0.prev = 3;
                  _iterator12 = _getIterator(this);
                case 5:
                  if (_iteratorNormalCompletion12 = (_step12 = _iterator12.next()).done) {
                    context$1$0.next = 12;
                    break;
                  }
                  x = _step12.value;
                  context$1$0.next = 9;
                  return fn(x);
                case 9:
                  _iteratorNormalCompletion12 = true;
                  context$1$0.next = 5;
                  break;
                case 12:
                  context$1$0.next = 18;
                  break;
                case 14:
                  context$1$0.prev = 14;
                  context$1$0.t0 = context$1$0["catch"](3);
                  _didIteratorError12 = true;
                  _iteratorError12 = context$1$0.t0;
                case 18:
                  context$1$0.prev = 18;
                  context$1$0.prev = 19;
                  if (!_iteratorNormalCompletion12 && _iterator12["return"]) {
                    _iterator12["return"]();
                  }
                case 21:
                  context$1$0.prev = 21;
                  if (!_didIteratorError12) {
                    context$1$0.next = 24;
                    break;
                  }
                  throw _iteratorError12;
                case 24:
                  return context$1$0.finish(21);
                case 25:
                  return context$1$0.finish(18);
                case 26:
                case "end":
                  return context$1$0.stop();
              }
          }, callee$0$0, this, [[3, 14, 18, 26], [19, , 21, 25]]);
        }));
        rewrapPrototypeAndStatic("pluck", _regeneratorRuntime.mark(function callee$0$0(name) {
          var _iteratorNormalCompletion13,
              _didIteratorError13,
              _iteratorError13,
              _iterator13,
              _step13,
              x;
          return _regeneratorRuntime.wrap(function callee$0$0$(context$1$0) {
            while (1)
              switch (context$1$0.prev = context$1$0.next) {
                case 0:
                  _iteratorNormalCompletion13 = true;
                  _didIteratorError13 = false;
                  _iteratorError13 = undefined;
                  context$1$0.prev = 3;
                  _iterator13 = _getIterator(this);
                case 5:
                  if (_iteratorNormalCompletion13 = (_step13 = _iterator13.next()).done) {
                    context$1$0.next = 12;
                    break;
                  }
                  x = _step13.value;
                  context$1$0.next = 9;
                  return x[name];
                case 9:
                  _iteratorNormalCompletion13 = true;
                  context$1$0.next = 5;
                  break;
                case 12:
                  context$1$0.next = 18;
                  break;
                case 14:
                  context$1$0.prev = 14;
                  context$1$0.t0 = context$1$0["catch"](3);
                  _didIteratorError13 = true;
                  _iteratorError13 = context$1$0.t0;
                case 18:
                  context$1$0.prev = 18;
                  context$1$0.prev = 19;
                  if (!_iteratorNormalCompletion13 && _iterator13["return"]) {
                    _iterator13["return"]();
                  }
                case 21:
                  context$1$0.prev = 21;
                  if (!_didIteratorError13) {
                    context$1$0.next = 24;
                    break;
                  }
                  throw _iteratorError13;
                case 24:
                  return context$1$0.finish(21);
                case 25:
                  return context$1$0.finish(18);
                case 26:
                case "end":
                  return context$1$0.stop();
              }
          }, callee$0$0, this, [[3, 14, 18, 26], [19, , 21, 25]]);
        }));
        rewrapPrototypeAndStatic("reductions", _regeneratorRuntime.mark(function callee$0$0(fn) {
          var initial = arguments.length <= 1 || arguments[1] === undefined ? undefined : arguments[1];
          var val,
              _iteratorNormalCompletion14,
              _didIteratorError14,
              _iteratorError14,
              _iterator14,
              _step14,
              x,
              _iteratorNormalCompletion15,
              _didIteratorError15,
              _iteratorError15,
              _iterator15,
              _step15;
          return _regeneratorRuntime.wrap(function callee$0$0$(context$1$0) {
            while (1)
              switch (context$1$0.prev = context$1$0.next) {
                case 0:
                  val = initial;
                  if (!(val === undefined)) {
                    context$1$0.next = 28;
                    break;
                  }
                  _iteratorNormalCompletion14 = true;
                  _didIteratorError14 = false;
                  _iteratorError14 = undefined;
                  context$1$0.prev = 5;
                  _iterator14 = _getIterator(this);
                case 7:
                  if (_iteratorNormalCompletion14 = (_step14 = _iterator14.next()).done) {
                    context$1$0.next = 14;
                    break;
                  }
                  x = _step14.value;
                  val = x;
                  return context$1$0.abrupt("break", 14);
                case 11:
                  _iteratorNormalCompletion14 = true;
                  context$1$0.next = 7;
                  break;
                case 14:
                  context$1$0.next = 20;
                  break;
                case 16:
                  context$1$0.prev = 16;
                  context$1$0.t0 = context$1$0["catch"](5);
                  _didIteratorError14 = true;
                  _iteratorError14 = context$1$0.t0;
                case 20:
                  context$1$0.prev = 20;
                  context$1$0.prev = 21;
                  if (!_iteratorNormalCompletion14 && _iterator14["return"]) {
                    _iterator14["return"]();
                  }
                case 23:
                  context$1$0.prev = 23;
                  if (!_didIteratorError14) {
                    context$1$0.next = 26;
                    break;
                  }
                  throw _iteratorError14;
                case 26:
                  return context$1$0.finish(23);
                case 27:
                  return context$1$0.finish(20);
                case 28:
                  context$1$0.next = 30;
                  return val;
                case 30:
                  _iteratorNormalCompletion15 = true;
                  _didIteratorError15 = false;
                  _iteratorError15 = undefined;
                  context$1$0.prev = 33;
                  _iterator15 = _getIterator(this);
                case 35:
                  if (_iteratorNormalCompletion15 = (_step15 = _iterator15.next()).done) {
                    context$1$0.next = 42;
                    break;
                  }
                  x = _step15.value;
                  context$1$0.next = 39;
                  return val = fn(val, x);
                case 39:
                  _iteratorNormalCompletion15 = true;
                  context$1$0.next = 35;
                  break;
                case 42:
                  context$1$0.next = 48;
                  break;
                case 44:
                  context$1$0.prev = 44;
                  context$1$0.t1 = context$1$0["catch"](33);
                  _didIteratorError15 = true;
                  _iteratorError15 = context$1$0.t1;
                case 48:
                  context$1$0.prev = 48;
                  context$1$0.prev = 49;
                  if (!_iteratorNormalCompletion15 && _iterator15["return"]) {
                    _iterator15["return"]();
                  }
                case 51:
                  context$1$0.prev = 51;
                  if (!_didIteratorError15) {
                    context$1$0.next = 54;
                    break;
                  }
                  throw _iteratorError15;
                case 54:
                  return context$1$0.finish(51);
                case 55:
                  return context$1$0.finish(48);
                case 56:
                  return context$1$0.abrupt("return", val);
                case 57:
                case "end":
                  return context$1$0.stop();
              }
          }, callee$0$0, this, [[5, 16, 20, 28], [21, , 23, 27], [33, 44, 48, 56], [49, , 51, 55]]);
        }), 2);
        rewrapPrototypeAndStatic("reject", _regeneratorRuntime.mark(function callee$0$0() {
          var fn = arguments.length <= 0 || arguments[0] === undefined ? Boolean : arguments[0];
          var _iteratorNormalCompletion16,
              _didIteratorError16,
              _iteratorError16,
              _iterator16,
              _step16,
              x;
          return _regeneratorRuntime.wrap(function callee$0$0$(context$1$0) {
            while (1)
              switch (context$1$0.prev = context$1$0.next) {
                case 0:
                  _iteratorNormalCompletion16 = true;
                  _didIteratorError16 = false;
                  _iteratorError16 = undefined;
                  context$1$0.prev = 3;
                  _iterator16 = _getIterator(this);
                case 5:
                  if (_iteratorNormalCompletion16 = (_step16 = _iterator16.next()).done) {
                    context$1$0.next = 13;
                    break;
                  }
                  x = _step16.value;
                  if (fn(x)) {
                    context$1$0.next = 10;
                    break;
                  }
                  context$1$0.next = 10;
                  return x;
                case 10:
                  _iteratorNormalCompletion16 = true;
                  context$1$0.next = 5;
                  break;
                case 13:
                  context$1$0.next = 19;
                  break;
                case 15:
                  context$1$0.prev = 15;
                  context$1$0.t0 = context$1$0["catch"](3);
                  _didIteratorError16 = true;
                  _iteratorError16 = context$1$0.t0;
                case 19:
                  context$1$0.prev = 19;
                  context$1$0.prev = 20;
                  if (!_iteratorNormalCompletion16 && _iterator16["return"]) {
                    _iterator16["return"]();
                  }
                case 22:
                  context$1$0.prev = 22;
                  if (!_didIteratorError16) {
                    context$1$0.next = 25;
                    break;
                  }
                  throw _iteratorError16;
                case 25:
                  return context$1$0.finish(22);
                case 26:
                  return context$1$0.finish(19);
                case 27:
                case "end":
                  return context$1$0.stop();
              }
          }, callee$0$0, this, [[3, 15, 19, 27], [20, , 22, 26]]);
        }), 1);
        rewrapPrototypeAndStatic("slice", _regeneratorRuntime.mark(function callee$0$0() {
          var start = arguments.length <= 0 || arguments[0] === undefined ? 0 : arguments[0];
          var stop = arguments.length <= 1 || arguments[1] === undefined ? Infinity : arguments[1];
          var _iteratorNormalCompletion17,
              _didIteratorError17,
              _iteratorError17,
              _iterator17,
              _step17,
              _step17$value,
              x,
              i;
          return _regeneratorRuntime.wrap(function callee$0$0$(context$1$0) {
            while (1)
              switch (context$1$0.prev = context$1$0.next) {
                case 0:
                  if (!(stop < start)) {
                    context$1$0.next = 2;
                    break;
                  }
                  throw new RangeError("parameter `stop` (= " + stop + ") must be >= `start` (= " + start + ")");
                case 2:
                  _iteratorNormalCompletion17 = true;
                  _didIteratorError17 = false;
                  _iteratorError17 = undefined;
                  context$1$0.prev = 5;
                  _iterator17 = _getIterator(this.enumerate());
                case 7:
                  if (_iteratorNormalCompletion17 = (_step17 = _iterator17.next()).done) {
                    context$1$0.next = 20;
                    break;
                  }
                  _step17$value = _slicedToArray(_step17.value, 2);
                  x = _step17$value[0];
                  i = _step17$value[1];
                  if (!(i < start)) {
                    context$1$0.next = 13;
                    break;
                  }
                  return context$1$0.abrupt("continue", 17);
                case 13:
                  if (!(i >= stop)) {
                    context$1$0.next = 15;
                    break;
                  }
                  return context$1$0.abrupt("break", 20);
                case 15:
                  context$1$0.next = 17;
                  return x;
                case 17:
                  _iteratorNormalCompletion17 = true;
                  context$1$0.next = 7;
                  break;
                case 20:
                  context$1$0.next = 26;
                  break;
                case 22:
                  context$1$0.prev = 22;
                  context$1$0.t0 = context$1$0["catch"](5);
                  _didIteratorError17 = true;
                  _iteratorError17 = context$1$0.t0;
                case 26:
                  context$1$0.prev = 26;
                  context$1$0.prev = 27;
                  if (!_iteratorNormalCompletion17 && _iterator17["return"]) {
                    _iterator17["return"]();
                  }
                case 29:
                  context$1$0.prev = 29;
                  if (!_didIteratorError17) {
                    context$1$0.next = 32;
                    break;
                  }
                  throw _iteratorError17;
                case 32:
                  return context$1$0.finish(29);
                case 33:
                  return context$1$0.finish(26);
                case 34:
                case "end":
                  return context$1$0.stop();
              }
          }, callee$0$0, this, [[5, 22, 26, 34], [27, , 29, 33]]);
        }), 2);
        rewrapPrototypeAndStatic("spreadMap", _regeneratorRuntime.mark(function callee$0$0(fn) {
          var _iteratorNormalCompletion18,
              _didIteratorError18,
              _iteratorError18,
              _iterator18,
              _step18,
              x;
          return _regeneratorRuntime.wrap(function callee$0$0$(context$1$0) {
            while (1)
              switch (context$1$0.prev = context$1$0.next) {
                case 0:
                  _iteratorNormalCompletion18 = true;
                  _didIteratorError18 = false;
                  _iteratorError18 = undefined;
                  context$1$0.prev = 3;
                  _iterator18 = _getIterator(this);
                case 5:
                  if (_iteratorNormalCompletion18 = (_step18 = _iterator18.next()).done) {
                    context$1$0.next = 12;
                    break;
                  }
                  x = _step18.value;
                  context$1$0.next = 9;
                  return fn.apply(undefined, _toConsumableArray(x));
                case 9:
                  _iteratorNormalCompletion18 = true;
                  context$1$0.next = 5;
                  break;
                case 12:
                  context$1$0.next = 18;
                  break;
                case 14:
                  context$1$0.prev = 14;
                  context$1$0.t0 = context$1$0["catch"](3);
                  _didIteratorError18 = true;
                  _iteratorError18 = context$1$0.t0;
                case 18:
                  context$1$0.prev = 18;
                  context$1$0.prev = 19;
                  if (!_iteratorNormalCompletion18 && _iterator18["return"]) {
                    _iterator18["return"]();
                  }
                case 21:
                  context$1$0.prev = 21;
                  if (!_didIteratorError18) {
                    context$1$0.next = 24;
                    break;
                  }
                  throw _iteratorError18;
                case 24:
                  return context$1$0.finish(21);
                case 25:
                  return context$1$0.finish(18);
                case 26:
                case "end":
                  return context$1$0.stop();
              }
          }, callee$0$0, this, [[3, 14, 18, 26], [19, , 21, 25]]);
        }));
        rewrapPrototypeAndStatic("take", _regeneratorRuntime.mark(function callee$0$0(n) {
          var i,
              _iteratorNormalCompletion19,
              _didIteratorError19,
              _iteratorError19,
              _iterator19,
              _step19,
              x;
          return _regeneratorRuntime.wrap(function callee$0$0$(context$1$0) {
            while (1)
              switch (context$1$0.prev = context$1$0.next) {
                case 0:
                  if (!(n < 1)) {
                    context$1$0.next = 2;
                    break;
                  }
                  return context$1$0.abrupt("return");
                case 2:
                  i = 0;
                  _iteratorNormalCompletion19 = true;
                  _didIteratorError19 = false;
                  _iteratorError19 = undefined;
                  context$1$0.prev = 6;
                  _iterator19 = _getIterator(this);
                case 8:
                  if (_iteratorNormalCompletion19 = (_step19 = _iterator19.next()).done) {
                    context$1$0.next = 17;
                    break;
                  }
                  x = _step19.value;
                  context$1$0.next = 12;
                  return x;
                case 12:
                  if (!(++i >= n)) {
                    context$1$0.next = 14;
                    break;
                  }
                  return context$1$0.abrupt("break", 17);
                case 14:
                  _iteratorNormalCompletion19 = true;
                  context$1$0.next = 8;
                  break;
                case 17:
                  context$1$0.next = 23;
                  break;
                case 19:
                  context$1$0.prev = 19;
                  context$1$0.t0 = context$1$0["catch"](6);
                  _didIteratorError19 = true;
                  _iteratorError19 = context$1$0.t0;
                case 23:
                  context$1$0.prev = 23;
                  context$1$0.prev = 24;
                  if (!_iteratorNormalCompletion19 && _iterator19["return"]) {
                    _iterator19["return"]();
                  }
                case 26:
                  context$1$0.prev = 26;
                  if (!_didIteratorError19) {
                    context$1$0.next = 29;
                    break;
                  }
                  throw _iteratorError19;
                case 29:
                  return context$1$0.finish(26);
                case 30:
                  return context$1$0.finish(23);
                case 31:
                case "end":
                  return context$1$0.stop();
              }
          }, callee$0$0, this, [[6, 19, 23, 31], [24, , 26, 30]]);
        }));
        rewrapPrototypeAndStatic("takeWhile", _regeneratorRuntime.mark(function callee$0$0() {
          var fn = arguments.length <= 0 || arguments[0] === undefined ? Boolean : arguments[0];
          var _iteratorNormalCompletion20,
              _didIteratorError20,
              _iteratorError20,
              _iterator20,
              _step20,
              x;
          return _regeneratorRuntime.wrap(function callee$0$0$(context$1$0) {
            while (1)
              switch (context$1$0.prev = context$1$0.next) {
                case 0:
                  _iteratorNormalCompletion20 = true;
                  _didIteratorError20 = false;
                  _iteratorError20 = undefined;
                  context$1$0.prev = 3;
                  _iterator20 = _getIterator(this);
                case 5:
                  if (_iteratorNormalCompletion20 = (_step20 = _iterator20.next()).done) {
                    context$1$0.next = 14;
                    break;
                  }
                  x = _step20.value;
                  if (fn(x)) {
                    context$1$0.next = 9;
                    break;
                  }
                  return context$1$0.abrupt("break", 14);
                case 9:
                  context$1$0.next = 11;
                  return x;
                case 11:
                  _iteratorNormalCompletion20 = true;
                  context$1$0.next = 5;
                  break;
                case 14:
                  context$1$0.next = 20;
                  break;
                case 16:
                  context$1$0.prev = 16;
                  context$1$0.t0 = context$1$0["catch"](3);
                  _didIteratorError20 = true;
                  _iteratorError20 = context$1$0.t0;
                case 20:
                  context$1$0.prev = 20;
                  context$1$0.prev = 21;
                  if (!_iteratorNormalCompletion20 && _iterator20["return"]) {
                    _iterator20["return"]();
                  }
                case 23:
                  context$1$0.prev = 23;
                  if (!_didIteratorError20) {
                    context$1$0.next = 26;
                    break;
                  }
                  throw _iteratorError20;
                case 26:
                  return context$1$0.finish(23);
                case 27:
                  return context$1$0.finish(20);
                case 28:
                case "end":
                  return context$1$0.stop();
              }
          }, callee$0$0, this, [[3, 16, 20, 28], [21, , 23, 27]]);
        }), 1);
        rewrapPrototypeAndStatic("tap", _regeneratorRuntime.mark(function callee$0$0() {
          var fn = arguments.length <= 0 || arguments[0] === undefined ? console.log.bind(console) : arguments[0];
          var _iteratorNormalCompletion21,
              _didIteratorError21,
              _iteratorError21,
              _iterator21,
              _step21,
              x;
          return _regeneratorRuntime.wrap(function callee$0$0$(context$1$0) {
            while (1)
              switch (context$1$0.prev = context$1$0.next) {
                case 0:
                  _iteratorNormalCompletion21 = true;
                  _didIteratorError21 = false;
                  _iteratorError21 = undefined;
                  context$1$0.prev = 3;
                  _iterator21 = _getIterator(this);
                case 5:
                  if (_iteratorNormalCompletion21 = (_step21 = _iterator21.next()).done) {
                    context$1$0.next = 13;
                    break;
                  }
                  x = _step21.value;
                  fn(x);
                  context$1$0.next = 10;
                  return x;
                case 10:
                  _iteratorNormalCompletion21 = true;
                  context$1$0.next = 5;
                  break;
                case 13:
                  context$1$0.next = 19;
                  break;
                case 15:
                  context$1$0.prev = 15;
                  context$1$0.t0 = context$1$0["catch"](3);
                  _didIteratorError21 = true;
                  _iteratorError21 = context$1$0.t0;
                case 19:
                  context$1$0.prev = 19;
                  context$1$0.prev = 20;
                  if (!_iteratorNormalCompletion21 && _iterator21["return"]) {
                    _iterator21["return"]();
                  }
                case 22:
                  context$1$0.prev = 22;
                  if (!_didIteratorError21) {
                    context$1$0.next = 25;
                    break;
                  }
                  throw _iteratorError21;
                case 25:
                  return context$1$0.finish(22);
                case 26:
                  return context$1$0.finish(19);
                case 27:
                case "end":
                  return context$1$0.stop();
              }
          }, callee$0$0, this, [[3, 15, 19, 27], [20, , 22, 26]]);
        }), 1);
        rewrapPrototypeAndStatic("unique", _regeneratorRuntime.mark(function callee$0$0() {
          var seen,
              _iteratorNormalCompletion22,
              _didIteratorError22,
              _iteratorError22,
              _iterator22,
              _step22,
              x;
          return _regeneratorRuntime.wrap(function callee$0$0$(context$1$0) {
            while (1)
              switch (context$1$0.prev = context$1$0.next) {
                case 0:
                  seen = new _Set();
                  _iteratorNormalCompletion22 = true;
                  _didIteratorError22 = false;
                  _iteratorError22 = undefined;
                  context$1$0.prev = 4;
                  _iterator22 = _getIterator(this);
                case 6:
                  if (_iteratorNormalCompletion22 = (_step22 = _iterator22.next()).done) {
                    context$1$0.next = 15;
                    break;
                  }
                  x = _step22.value;
                  if (seen.has(x)) {
                    context$1$0.next = 12;
                    break;
                  }
                  context$1$0.next = 11;
                  return x;
                case 11:
                  seen.add(x);
                case 12:
                  _iteratorNormalCompletion22 = true;
                  context$1$0.next = 6;
                  break;
                case 15:
                  context$1$0.next = 21;
                  break;
                case 17:
                  context$1$0.prev = 17;
                  context$1$0.t0 = context$1$0["catch"](4);
                  _didIteratorError22 = true;
                  _iteratorError22 = context$1$0.t0;
                case 21:
                  context$1$0.prev = 21;
                  context$1$0.prev = 22;
                  if (!_iteratorNormalCompletion22 && _iterator22["return"]) {
                    _iterator22["return"]();
                  }
                case 24:
                  context$1$0.prev = 24;
                  if (!_didIteratorError22) {
                    context$1$0.next = 27;
                    break;
                  }
                  throw _iteratorError22;
                case 27:
                  return context$1$0.finish(24);
                case 28:
                  return context$1$0.finish(21);
                case 29:
                  seen.clear();
                case 30:
                case "end":
                  return context$1$0.stop();
              }
          }, callee$0$0, this, [[4, 17, 21, 29], [22, , 24, 28]]);
        }));
        var _zip = rewrap(_regeneratorRuntime.mark(function callee$0$0(iterables) {
          var longest = arguments.length <= 1 || arguments[1] === undefined ? false : arguments[1];
          var iters,
              numIters,
              numFinished,
              finished,
              zipped,
              _iteratorNormalCompletion23,
              _didIteratorError23,
              _iteratorError23,
              _iterator23,
              _step23,
              it,
              _it$next,
              value,
              done;
          return _regeneratorRuntime.wrap(function callee$0$0$(context$1$0) {
            while (1)
              switch (context$1$0.prev = context$1$0.next) {
                case 0:
                  if (iterables.length) {
                    context$1$0.next = 2;
                    break;
                  }
                  return context$1$0.abrupt("return");
                case 2:
                  iters = iterables.map(getIterator);
                  numIters = iterables.length;
                  numFinished = 0;
                  finished = false;
                case 6:
                  if (finished) {
                    context$1$0.next = 44;
                    break;
                  }
                  zipped = [];
                  _iteratorNormalCompletion23 = true;
                  _didIteratorError23 = false;
                  _iteratorError23 = undefined;
                  context$1$0.prev = 11;
                  _iterator23 = _getIterator(iters);
                case 13:
                  if (_iteratorNormalCompletion23 = (_step23 = _iterator23.next()).done) {
                    context$1$0.next = 26;
                    break;
                  }
                  it = _step23.value;
                  _it$next = it.next();
                  value = _it$next.value;
                  done = _it$next.done;
                  if (!done) {
                    context$1$0.next = 22;
                    break;
                  }
                  if (longest) {
                    context$1$0.next = 21;
                    break;
                  }
                  return context$1$0.abrupt("return");
                case 21:
                  if (++numFinished == numIters) {
                    finished = true;
                  }
                case 22:
                  if (value === undefined) {
                    zipped.length++;
                  } else {
                    zipped.push(value);
                  }
                case 23:
                  _iteratorNormalCompletion23 = true;
                  context$1$0.next = 13;
                  break;
                case 26:
                  context$1$0.next = 32;
                  break;
                case 28:
                  context$1$0.prev = 28;
                  context$1$0.t0 = context$1$0["catch"](11);
                  _didIteratorError23 = true;
                  _iteratorError23 = context$1$0.t0;
                case 32:
                  context$1$0.prev = 32;
                  context$1$0.prev = 33;
                  if (!_iteratorNormalCompletion23 && _iterator23["return"]) {
                    _iterator23["return"]();
                  }
                case 35:
                  context$1$0.prev = 35;
                  if (!_didIteratorError23) {
                    context$1$0.next = 38;
                    break;
                  }
                  throw _iteratorError23;
                case 38:
                  return context$1$0.finish(35);
                case 39:
                  return context$1$0.finish(32);
                case 40:
                  context$1$0.next = 42;
                  return zipped;
                case 42:
                  context$1$0.next = 6;
                  break;
                case 44:
                case "end":
                  return context$1$0.stop();
              }
          }, callee$0$0, this, [[11, 28, 32, 40], [33, , 35, 39]]);
        }));
        rewrapStaticMethod("zip", _regeneratorRuntime.mark(function callee$0$0() {
          for (var _len7 = arguments.length,
              iterables = Array(_len7),
              _key7 = 0; _key7 < _len7; _key7++) {
            iterables[_key7] = arguments[_key7];
          }
          return _regeneratorRuntime.wrap(function callee$0$0$(context$1$0) {
            while (1)
              switch (context$1$0.prev = context$1$0.next) {
                case 0:
                  return context$1$0.delegateYield(_zip(iterables), "t0", 1);
                case 1:
                case "end":
                  return context$1$0.stop();
              }
          }, callee$0$0, this);
        }));
        rewrapStaticMethod("zipLongest", _regeneratorRuntime.mark(function callee$0$0() {
          for (var _len8 = arguments.length,
              iterables = Array(_len8),
              _key8 = 0; _key8 < _len8; _key8++) {
            iterables[_key8] = arguments[_key8];
          }
          return _regeneratorRuntime.wrap(function callee$0$0$(context$1$0) {
            while (1)
              switch (context$1$0.prev = context$1$0.next) {
                case 0:
                  return context$1$0.delegateYield(_zip(iterables, true), "t0", 1);
                case 1:
                case "end":
                  return context$1$0.stop();
              }
          }, callee$0$0, this);
        }));
        rewrapStaticMethod("zipWith", _regeneratorRuntime.mark(function callee$0$0(fn) {
          for (var _len9 = arguments.length,
              iterables = Array(_len9 > 1 ? _len9 - 1 : 0),
              _key9 = 1; _key9 < _len9; _key9++) {
            iterables[_key9 - 1] = arguments[_key9];
          }
          return _regeneratorRuntime.wrap(function callee$0$0$(context$1$0) {
            while (1)
              switch (context$1$0.prev = context$1$0.next) {
                case 0:
                  return context$1$0.delegateYield(_zip(iterables).spreadMap(fn), "t0", 1);
                case 1:
                case "end":
                  return context$1$0.stop();
              }
          }, callee$0$0, this);
        }));
        wu.MAX_BLOCK = 15;
        wu.TIMEOUT = 1;
        prototypeAndStatic("asyncEach", function(fn) {
          var maxBlock = arguments.length <= 1 || arguments[1] === undefined ? wu.MAX_BLOCK : arguments[1];
          var timeout = arguments.length <= 2 || arguments[2] === undefined ? wu.TIMEOUT : arguments[2];
          var iter = getIterator(this);
          return new _Promise(function(resolve, reject) {
            (function loop() {
              var start = Date.now();
              var _iteratorNormalCompletion24 = true;
              var _didIteratorError24 = false;
              var _iteratorError24 = undefined;
              try {
                for (var _iterator24 = _getIterator(iter),
                    _step24; !(_iteratorNormalCompletion24 = (_step24 = _iterator24.next()).done); _iteratorNormalCompletion24 = true) {
                  var x = _step24.value;
                  try {
                    fn(x);
                  } catch (e) {
                    reject(e);
                    return;
                  }
                  if (Date.now() - start > maxBlock) {
                    setTimeout(loop, timeout);
                    return;
                  }
                }
              } catch (err) {
                _didIteratorError24 = true;
                _iteratorError24 = err;
              } finally {
                try {
                  if (!_iteratorNormalCompletion24 && _iterator24["return"]) {
                    _iterator24["return"]();
                  }
                } finally {
                  if (_didIteratorError24) {
                    throw _iteratorError24;
                  }
                }
              }
              resolve();
            })();
          });
        }, 3);
        prototypeAndStatic("every", function() {
          var fn = arguments.length <= 0 || arguments[0] === undefined ? Boolean : arguments[0];
          var _iteratorNormalCompletion25 = true;
          var _didIteratorError25 = false;
          var _iteratorError25 = undefined;
          try {
            for (var _iterator25 = _getIterator(this),
                _step25; !(_iteratorNormalCompletion25 = (_step25 = _iterator25.next()).done); _iteratorNormalCompletion25 = true) {
              var x = _step25.value;
              if (!fn(x)) {
                return false;
              }
            }
          } catch (err) {
            _didIteratorError25 = true;
            _iteratorError25 = err;
          } finally {
            try {
              if (!_iteratorNormalCompletion25 && _iterator25["return"]) {
                _iterator25["return"]();
              }
            } finally {
              if (_didIteratorError25) {
                throw _iteratorError25;
              }
            }
          }
          return true;
        }, 1);
        prototypeAndStatic("find", function(fn) {
          var _iteratorNormalCompletion26 = true;
          var _didIteratorError26 = false;
          var _iteratorError26 = undefined;
          try {
            for (var _iterator26 = _getIterator(this),
                _step26; !(_iteratorNormalCompletion26 = (_step26 = _iterator26.next()).done); _iteratorNormalCompletion26 = true) {
              var x = _step26.value;
              if (fn(x)) {
                return x;
              }
            }
          } catch (err) {
            _didIteratorError26 = true;
            _iteratorError26 = err;
          } finally {
            try {
              if (!_iteratorNormalCompletion26 && _iterator26["return"]) {
                _iterator26["return"]();
              }
            } finally {
              if (_didIteratorError26) {
                throw _iteratorError26;
              }
            }
          }
        });
        prototypeAndStatic("forEach", function(fn) {
          var _iteratorNormalCompletion27 = true;
          var _didIteratorError27 = false;
          var _iteratorError27 = undefined;
          try {
            for (var _iterator27 = _getIterator(this),
                _step27; !(_iteratorNormalCompletion27 = (_step27 = _iterator27.next()).done); _iteratorNormalCompletion27 = true) {
              var x = _step27.value;
              fn(x);
            }
          } catch (err) {
            _didIteratorError27 = true;
            _iteratorError27 = err;
          } finally {
            try {
              if (!_iteratorNormalCompletion27 && _iterator27["return"]) {
                _iterator27["return"]();
              }
            } finally {
              if (_didIteratorError27) {
                throw _iteratorError27;
              }
            }
          }
        });
        prototypeAndStatic("has", function(thing) {
          return this.some(function(x) {
            return x === thing;
          });
        });
        prototypeAndStatic("reduce", function(fn) {
          var initial = arguments.length <= 1 || arguments[1] === undefined ? undefined : arguments[1];
          var val = initial;
          if (val === undefined) {
            var _iteratorNormalCompletion28 = true;
            var _didIteratorError28 = false;
            var _iteratorError28 = undefined;
            try {
              for (var _iterator28 = _getIterator(this),
                  _step28; !(_iteratorNormalCompletion28 = (_step28 = _iterator28.next()).done); _iteratorNormalCompletion28 = true) {
                var x = _step28.value;
                val = x;
                break;
              }
            } catch (err) {
              _didIteratorError28 = true;
              _iteratorError28 = err;
            } finally {
              try {
                if (!_iteratorNormalCompletion28 && _iterator28["return"]) {
                  _iterator28["return"]();
                }
              } finally {
                if (_didIteratorError28) {
                  throw _iteratorError28;
                }
              }
            }
          }
          var _iteratorNormalCompletion29 = true;
          var _didIteratorError29 = false;
          var _iteratorError29 = undefined;
          try {
            for (var _iterator29 = _getIterator(this),
                _step29; !(_iteratorNormalCompletion29 = (_step29 = _iterator29.next()).done); _iteratorNormalCompletion29 = true) {
              var x = _step29.value;
              val = fn(val, x);
            }
          } catch (err) {
            _didIteratorError29 = true;
            _iteratorError29 = err;
          } finally {
            try {
              if (!_iteratorNormalCompletion29 && _iterator29["return"]) {
                _iterator29["return"]();
              }
            } finally {
              if (_didIteratorError29) {
                throw _iteratorError29;
              }
            }
          }
          return val;
        }, 2);
        prototypeAndStatic("some", function() {
          var fn = arguments.length <= 0 || arguments[0] === undefined ? Boolean : arguments[0];
          var _iteratorNormalCompletion30 = true;
          var _didIteratorError30 = false;
          var _iteratorError30 = undefined;
          try {
            for (var _iterator30 = _getIterator(this),
                _step30; !(_iteratorNormalCompletion30 = (_step30 = _iterator30.next()).done); _iteratorNormalCompletion30 = true) {
              var x = _step30.value;
              if (fn(x)) {
                return true;
              }
            }
          } catch (err) {
            _didIteratorError30 = true;
            _iteratorError30 = err;
          } finally {
            try {
              if (!_iteratorNormalCompletion30 && _iterator30["return"]) {
                _iterator30["return"]();
              }
            } finally {
              if (_didIteratorError30) {
                throw _iteratorError30;
              }
            }
          }
          return false;
        }, 1);
        prototypeAndStatic("toArray", function() {
          return [].concat(_toConsumableArray(this));
        });
        var MAX_CACHE = 500;
        var _tee = rewrap(_regeneratorRuntime.mark(function callee$0$0(iterator, cache) {
          var items,
              index,
              _iterator$next,
              done,
              value;
          return _regeneratorRuntime.wrap(function callee$0$0$(context$1$0) {
            while (1)
              switch (context$1$0.prev = context$1$0.next) {
                case 0:
                  items = cache.items;
                  index = 0;
                case 2:
                  if (false) {
                    context$1$0.next = 25;
                    break;
                  }
                  if (!(index === items.length)) {
                    context$1$0.next = 14;
                    break;
                  }
                  _iterator$next = iterator.next();
                  done = _iterator$next.done;
                  value = _iterator$next.value;
                  if (!done) {
                    context$1$0.next = 10;
                    break;
                  }
                  if (cache.returned === MISSING) {
                    cache.returned = value;
                  }
                  return context$1$0.abrupt("break", 25);
                case 10:
                  context$1$0.next = 12;
                  return items[index++] = value;
                case 12:
                  context$1$0.next = 23;
                  break;
                case 14:
                  if (!(index === cache.tail)) {
                    context$1$0.next = 21;
                    break;
                  }
                  value = items[index];
                  if (index === MAX_CACHE) {
                    items = cache.items = items.slice(index);
                    index = 0;
                    cache.tail = 0;
                  } else {
                    items[index] = undefined;
                    cache.tail = ++index;
                  }
                  context$1$0.next = 19;
                  return value;
                case 19:
                  context$1$0.next = 23;
                  break;
                case 21:
                  context$1$0.next = 23;
                  return items[index++];
                case 23:
                  context$1$0.next = 2;
                  break;
                case 25:
                  if (cache.tail === index) {
                    items.length = 0;
                  }
                  return context$1$0.abrupt("return", cache.returned);
                case 27:
                case "end":
                  return context$1$0.stop();
              }
          }, callee$0$0, this);
        }));
        _tee.prototype = Wu.prototype;
        prototypeAndStatic("tee", function() {
          var n = arguments.length <= 0 || arguments[0] === undefined ? 2 : arguments[0];
          var iterables = new Array(n);
          var cache = {
            tail: 0,
            items: [],
            returned: MISSING
          };
          while (n--) {
            iterables[n] = _tee(this, cache);
          }
          return iterables;
        }, 1);
        prototypeAndStatic("unzip", function() {
          var n = arguments.length <= 0 || arguments[0] === undefined ? 2 : arguments[0];
          return this.tee(n).map(function(iter, i) {
            return iter.pluck(i);
          });
        }, 1);
        wu.tang = {clan: 36};
      }, function(module, exports, __webpack_require__) {
        "use strict";
        var _Array$from = __webpack_require__(2)["default"];
        exports["default"] = function(arr) {
          if (Array.isArray(arr)) {
            for (var i = 0,
                arr2 = Array(arr.length); i < arr.length; i++)
              arr2[i] = arr[i];
            return arr2;
          } else {
            return _Array$from(arr);
          }
        };
        exports.__esModule = true;
      }, function(module, exports, __webpack_require__) {
        module.exports = {
          "default": __webpack_require__(3),
          __esModule: true
        };
      }, function(module, exports, __webpack_require__) {
        __webpack_require__(4);
        __webpack_require__(26);
        module.exports = __webpack_require__(12).Array.from;
      }, function(module, exports, __webpack_require__) {
        'use strict';
        var $at = __webpack_require__(5)(true);
        __webpack_require__(8)(String, 'String', function(iterated) {
          this._t = String(iterated);
          this._i = 0;
        }, function() {
          var O = this._t,
              index = this._i,
              point;
          if (index >= O.length)
            return {
              value: undefined,
              done: true
            };
          point = $at(O, index);
          this._i += point.length;
          return {
            value: point,
            done: false
          };
        });
      }, function(module, exports, __webpack_require__) {
        var toInteger = __webpack_require__(6),
            defined = __webpack_require__(7);
        module.exports = function(TO_STRING) {
          return function(that, pos) {
            var s = String(defined(that)),
                i = toInteger(pos),
                l = s.length,
                a,
                b;
            if (i < 0 || i >= l)
              return TO_STRING ? '' : undefined;
            a = s.charCodeAt(i);
            return a < 0xd800 || a > 0xdbff || i + 1 === l || (b = s.charCodeAt(i + 1)) < 0xdc00 || b > 0xdfff ? TO_STRING ? s.charAt(i) : a : TO_STRING ? s.slice(i, i + 2) : (a - 0xd800 << 10) + (b - 0xdc00) + 0x10000;
          };
        };
      }, function(module, exports) {
        var ceil = Math.ceil,
            floor = Math.floor;
        module.exports = function(it) {
          return isNaN(it = +it) ? 0 : (it > 0 ? floor : ceil)(it);
        };
      }, function(module, exports) {
        module.exports = function(it) {
          if (it == undefined)
            throw TypeError("Can't call method on  " + it);
          return it;
        };
      }, function(module, exports, __webpack_require__) {
        'use strict';
        var LIBRARY = __webpack_require__(9),
            $def = __webpack_require__(10),
            $redef = __webpack_require__(13),
            hide = __webpack_require__(14),
            has = __webpack_require__(19),
            SYMBOL_ITERATOR = __webpack_require__(20)('iterator'),
            Iterators = __webpack_require__(23),
            BUGGY = !([].keys && 'next' in [].keys()),
            FF_ITERATOR = '@@iterator',
            KEYS = 'keys',
            VALUES = 'values';
        var returnThis = function() {
          return this;
        };
        module.exports = function(Base, NAME, Constructor, next, DEFAULT, IS_SET, FORCE) {
          __webpack_require__(24)(Constructor, NAME, next);
          var createMethod = function(kind) {
            switch (kind) {
              case KEYS:
                return function keys() {
                  return new Constructor(this, kind);
                };
              case VALUES:
                return function values() {
                  return new Constructor(this, kind);
                };
            }
            return function entries() {
              return new Constructor(this, kind);
            };
          };
          var TAG = NAME + ' Iterator',
              proto = Base.prototype,
              _native = proto[SYMBOL_ITERATOR] || proto[FF_ITERATOR] || DEFAULT && proto[DEFAULT],
              _default = _native || createMethod(DEFAULT),
              methods,
              key;
          if (_native) {
            var IteratorPrototype = __webpack_require__(15).getProto(_default.call(new Base));
            __webpack_require__(25)(IteratorPrototype, TAG, true);
            if (!LIBRARY && has(proto, FF_ITERATOR))
              hide(IteratorPrototype, SYMBOL_ITERATOR, returnThis);
          }
          if (!LIBRARY || FORCE)
            hide(proto, SYMBOL_ITERATOR, _default);
          Iterators[NAME] = _default;
          Iterators[TAG] = returnThis;
          if (DEFAULT) {
            methods = {
              keys: IS_SET ? _default : createMethod(KEYS),
              values: DEFAULT == VALUES ? _default : createMethod(VALUES),
              entries: DEFAULT != VALUES ? _default : createMethod('entries')
            };
            if (FORCE)
              for (key in methods) {
                if (!(key in proto))
                  $redef(proto, key, methods[key]);
              }
            else
              $def($def.P + $def.F * BUGGY, NAME, methods);
          }
        };
      }, function(module, exports) {
        module.exports = true;
      }, function(module, exports, __webpack_require__) {
        var global = __webpack_require__(11),
            core = __webpack_require__(12),
            PROTOTYPE = 'prototype';
        var ctx = function(fn, that) {
          return function() {
            return fn.apply(that, arguments);
          };
        };
        var $def = function(type, name, source) {
          var key,
              own,
              out,
              exp,
              isGlobal = type & $def.G,
              isProto = type & $def.P,
              target = isGlobal ? global : type & $def.S ? global[name] : (global[name] || {})[PROTOTYPE],
              exports = isGlobal ? core : core[name] || (core[name] = {});
          if (isGlobal)
            source = name;
          for (key in source) {
            own = !(type & $def.F) && target && key in target;
            if (own && key in exports)
              continue;
            out = own ? target[key] : source[key];
            if (isGlobal && typeof target[key] != 'function')
              exp = source[key];
            else if (type & $def.B && own)
              exp = ctx(out, global);
            else if (type & $def.W && target[key] == out)
              !function(C) {
                exp = function(param) {
                  return this instanceof C ? new C(param) : C(param);
                };
                exp[PROTOTYPE] = C[PROTOTYPE];
              }(out);
            else
              exp = isProto && typeof out == 'function' ? ctx(Function.call, out) : out;
            exports[key] = exp;
            if (isProto)
              (exports[PROTOTYPE] || (exports[PROTOTYPE] = {}))[key] = out;
          }
        };
        $def.F = 1;
        $def.G = 2;
        $def.S = 4;
        $def.P = 8;
        $def.B = 16;
        $def.W = 32;
        module.exports = $def;
      }, function(module, exports) {
        var UNDEFINED = 'undefined';
        var global = module.exports = typeof window != UNDEFINED && window.Math == Math ? window : typeof self != UNDEFINED && self.Math == Math ? self : Function('return this')();
        if (typeof __g == 'number')
          __g = global;
      }, function(module, exports) {
        var core = module.exports = {version: '1.2.0'};
        if (typeof __e == 'number')
          __e = core;
      }, function(module, exports, __webpack_require__) {
        module.exports = __webpack_require__(14);
      }, function(module, exports, __webpack_require__) {
        var $ = __webpack_require__(15),
            createDesc = __webpack_require__(16);
        module.exports = __webpack_require__(17) ? function(object, key, value) {
          return $.setDesc(object, key, createDesc(1, value));
        } : function(object, key, value) {
          object[key] = value;
          return object;
        };
      }, function(module, exports) {
        var $Object = Object;
        module.exports = {
          create: $Object.create,
          getProto: $Object.getPrototypeOf,
          isEnum: {}.propertyIsEnumerable,
          getDesc: $Object.getOwnPropertyDescriptor,
          setDesc: $Object.defineProperty,
          setDescs: $Object.defineProperties,
          getKeys: $Object.keys,
          getNames: $Object.getOwnPropertyNames,
          getSymbols: $Object.getOwnPropertySymbols,
          each: [].forEach
        };
      }, function(module, exports) {
        module.exports = function(bitmap, value) {
          return {
            enumerable: !(bitmap & 1),
            configurable: !(bitmap & 2),
            writable: !(bitmap & 4),
            value: value
          };
        };
      }, function(module, exports, __webpack_require__) {
        module.exports = !__webpack_require__(18)(function() {
          return Object.defineProperty({}, 'a', {get: function() {
              return 7;
            }}).a != 7;
        });
      }, function(module, exports) {
        module.exports = function(exec) {
          try {
            return !!exec();
          } catch (e) {
            return true;
          }
        };
      }, function(module, exports) {
        var hasOwnProperty = {}.hasOwnProperty;
        module.exports = function(it, key) {
          return hasOwnProperty.call(it, key);
        };
      }, function(module, exports, __webpack_require__) {
        var store = __webpack_require__(21)('wks'),
            Symbol = __webpack_require__(11).Symbol;
        module.exports = function(name) {
          return store[name] || (store[name] = Symbol && Symbol[name] || (Symbol || __webpack_require__(22))('Symbol.' + name));
        };
      }, function(module, exports, __webpack_require__) {
        var global = __webpack_require__(11),
            SHARED = '__core-js_shared__',
            store = global[SHARED] || (global[SHARED] = {});
        module.exports = function(key) {
          return store[key] || (store[key] = {});
        };
      }, function(module, exports) {
        var id = 0,
            px = Math.random();
        module.exports = function(key) {
          return 'Symbol('.concat(key === undefined ? '' : key, ')_', (++id + px).toString(36));
        };
      }, function(module, exports) {
        module.exports = {};
      }, function(module, exports, __webpack_require__) {
        'use strict';
        var $ = __webpack_require__(15),
            IteratorPrototype = {};
        __webpack_require__(14)(IteratorPrototype, __webpack_require__(20)('iterator'), function() {
          return this;
        });
        module.exports = function(Constructor, NAME, next) {
          Constructor.prototype = $.create(IteratorPrototype, {next: __webpack_require__(16)(1, next)});
          __webpack_require__(25)(Constructor, NAME + ' Iterator');
        };
      }, function(module, exports, __webpack_require__) {
        var has = __webpack_require__(19),
            hide = __webpack_require__(14),
            TAG = __webpack_require__(20)('toStringTag');
        module.exports = function(it, tag, stat) {
          if (it && !has(it = stat ? it : it.prototype, TAG))
            hide(it, TAG, tag);
        };
      }, function(module, exports, __webpack_require__) {
        'use strict';
        var ctx = __webpack_require__(27),
            $def = __webpack_require__(10),
            toObject = __webpack_require__(29),
            call = __webpack_require__(30),
            isArrayIter = __webpack_require__(33),
            toLength = __webpack_require__(34),
            getIterFn = __webpack_require__(35);
        $def($def.S + $def.F * !__webpack_require__(38)(function(iter) {
          Array.from(iter);
        }), 'Array', {from: function from(arrayLike) {
            var O = toObject(arrayLike),
                C = typeof this == 'function' ? this : Array,
                mapfn = arguments[1],
                mapping = mapfn !== undefined,
                index = 0,
                iterFn = getIterFn(O),
                length,
                result,
                step,
                iterator;
            if (mapping)
              mapfn = ctx(mapfn, arguments[2], 2);
            if (iterFn != undefined && !(C == Array && isArrayIter(iterFn))) {
              for (iterator = iterFn.call(O), result = new C; !(step = iterator.next()).done; index++) {
                result[index] = mapping ? call(iterator, mapfn, [step.value, index], true) : step.value;
              }
            } else {
              length = toLength(O.length);
              for (result = new C(length); length > index; index++) {
                result[index] = mapping ? mapfn(O[index], index) : O[index];
              }
            }
            result.length = index;
            return result;
          }});
      }, function(module, exports, __webpack_require__) {
        var aFunction = __webpack_require__(28);
        module.exports = function(fn, that, length) {
          aFunction(fn);
          if (that === undefined)
            return fn;
          switch (length) {
            case 1:
              return function(a) {
                return fn.call(that, a);
              };
            case 2:
              return function(a, b) {
                return fn.call(that, a, b);
              };
            case 3:
              return function(a, b, c) {
                return fn.call(that, a, b, c);
              };
          }
          return function() {
            return fn.apply(that, arguments);
          };
        };
      }, function(module, exports) {
        module.exports = function(it) {
          if (typeof it != 'function')
            throw TypeError(it + ' is not a function!');
          return it;
        };
      }, function(module, exports, __webpack_require__) {
        var defined = __webpack_require__(7);
        module.exports = function(it) {
          return Object(defined(it));
        };
      }, function(module, exports, __webpack_require__) {
        var anObject = __webpack_require__(31);
        module.exports = function(iterator, fn, value, entries) {
          try {
            return entries ? fn(anObject(value)[0], value[1]) : fn(value);
          } catch (e) {
            var ret = iterator['return'];
            if (ret !== undefined)
              anObject(ret.call(iterator));
            throw e;
          }
        };
      }, function(module, exports, __webpack_require__) {
        var isObject = __webpack_require__(32);
        module.exports = function(it) {
          if (!isObject(it))
            throw TypeError(it + ' is not an object!');
          return it;
        };
      }, function(module, exports) {
        module.exports = function(it) {
          return typeof it === 'object' ? it !== null : typeof it === 'function';
        };
      }, function(module, exports, __webpack_require__) {
        var Iterators = __webpack_require__(23),
            ITERATOR = __webpack_require__(20)('iterator');
        module.exports = function(it) {
          return (Iterators.Array || Array.prototype[ITERATOR]) === it;
        };
      }, function(module, exports, __webpack_require__) {
        var toInteger = __webpack_require__(6),
            min = Math.min;
        module.exports = function(it) {
          return it > 0 ? min(toInteger(it), 0x1fffffffffffff) : 0;
        };
      }, function(module, exports, __webpack_require__) {
        var classof = __webpack_require__(36),
            ITERATOR = __webpack_require__(20)('iterator'),
            Iterators = __webpack_require__(23);
        module.exports = __webpack_require__(12).getIteratorMethod = function(it) {
          if (it != undefined)
            return it[ITERATOR] || it['@@iterator'] || Iterators[classof(it)];
        };
      }, function(module, exports, __webpack_require__) {
        var cof = __webpack_require__(37),
            TAG = __webpack_require__(20)('toStringTag'),
            ARG = cof(function() {
              return arguments;
            }()) == 'Arguments';
        module.exports = function(it) {
          var O,
              T,
              B;
          return it === undefined ? 'Undefined' : it === null ? 'Null' : typeof(T = (O = Object(it))[TAG]) == 'string' ? T : ARG ? cof(O) : (B = cof(O)) == 'Object' && typeof O.callee == 'function' ? 'Arguments' : B;
        };
      }, function(module, exports) {
        var toString = {}.toString;
        module.exports = function(it) {
          return toString.call(it).slice(8, -1);
        };
      }, function(module, exports, __webpack_require__) {
        var SYMBOL_ITERATOR = __webpack_require__(20)('iterator'),
            SAFE_CLOSING = false;
        try {
          var riter = [7][SYMBOL_ITERATOR]();
          riter['return'] = function() {
            SAFE_CLOSING = true;
          };
          Array.from(riter, function() {
            throw 2;
          });
        } catch (e) {}
        module.exports = function(exec) {
          if (!SAFE_CLOSING)
            return false;
          var safe = false;
          try {
            var arr = [7],
                iter = arr[SYMBOL_ITERATOR]();
            iter.next = function() {
              safe = true;
            };
            arr[SYMBOL_ITERATOR] = function() {
              return iter;
            };
            exec(arr);
          } catch (e) {}
          return safe;
        };
      }, function(module, exports, __webpack_require__) {
        "use strict";
        var _getIterator = __webpack_require__(40)["default"];
        var _isIterable = __webpack_require__(49)["default"];
        exports["default"] = (function() {
          function sliceIterator(arr, i) {
            var _arr = [];
            var _n = true;
            var _d = false;
            var _e = undefined;
            try {
              for (var _i = _getIterator(arr),
                  _s; !(_n = (_s = _i.next()).done); _n = true) {
                _arr.push(_s.value);
                if (i && _arr.length === i)
                  break;
              }
            } catch (err) {
              _d = true;
              _e = err;
            } finally {
              try {
                if (!_n && _i["return"])
                  _i["return"]();
              } finally {
                if (_d)
                  throw _e;
              }
            }
            return _arr;
          }
          return function(arr, i) {
            if (Array.isArray(arr)) {
              return arr;
            } else if (_isIterable(Object(arr))) {
              return sliceIterator(arr, i);
            } else {
              throw new TypeError("Invalid attempt to destructure non-iterable instance");
            }
          };
        })();
        exports.__esModule = true;
      }, function(module, exports, __webpack_require__) {
        module.exports = {
          "default": __webpack_require__(41),
          __esModule: true
        };
      }, function(module, exports, __webpack_require__) {
        __webpack_require__(42);
        __webpack_require__(4);
        module.exports = __webpack_require__(48);
      }, function(module, exports, __webpack_require__) {
        __webpack_require__(43);
        var Iterators = __webpack_require__(23);
        Iterators.NodeList = Iterators.HTMLCollection = Iterators.Array;
      }, function(module, exports, __webpack_require__) {
        'use strict';
        var setUnscope = __webpack_require__(44),
            step = __webpack_require__(45),
            Iterators = __webpack_require__(23),
            toIObject = __webpack_require__(46);
        __webpack_require__(8)(Array, 'Array', function(iterated, kind) {
          this._t = toIObject(iterated);
          this._i = 0;
          this._k = kind;
        }, function() {
          var O = this._t,
              kind = this._k,
              index = this._i++;
          if (!O || index >= O.length) {
            this._t = undefined;
            return step(1);
          }
          if (kind == 'keys')
            return step(0, index);
          if (kind == 'values')
            return step(0, O[index]);
          return step(0, [index, O[index]]);
        }, 'values');
        Iterators.Arguments = Iterators.Array;
        setUnscope('keys');
        setUnscope('values');
        setUnscope('entries');
      }, function(module, exports) {
        module.exports = function() {};
      }, function(module, exports) {
        module.exports = function(done, value) {
          return {
            value: value,
            done: !!done
          };
        };
      }, function(module, exports, __webpack_require__) {
        var IObject = __webpack_require__(47),
            defined = __webpack_require__(7);
        module.exports = function(it) {
          return IObject(defined(it));
        };
      }, function(module, exports, __webpack_require__) {
        var cof = __webpack_require__(37);
        module.exports = 0 in Object('z') ? Object : function(it) {
          return cof(it) == 'String' ? it.split('') : Object(it);
        };
      }, function(module, exports, __webpack_require__) {
        var anObject = __webpack_require__(31),
            get = __webpack_require__(35);
        module.exports = __webpack_require__(12).getIterator = function(it) {
          var iterFn = get(it);
          if (typeof iterFn != 'function')
            throw TypeError(it + ' is not iterable!');
          return anObject(iterFn.call(it));
        };
      }, function(module, exports, __webpack_require__) {
        module.exports = {
          "default": __webpack_require__(50),
          __esModule: true
        };
      }, function(module, exports, __webpack_require__) {
        __webpack_require__(42);
        __webpack_require__(4);
        module.exports = __webpack_require__(51);
      }, function(module, exports, __webpack_require__) {
        var classof = __webpack_require__(36),
            ITERATOR = __webpack_require__(20)('iterator'),
            Iterators = __webpack_require__(23);
        module.exports = __webpack_require__(12).isIterable = function(it) {
          var O = Object(it);
          return ITERATOR in O || '@@iterator' in O || Iterators.hasOwnProperty(classof(O));
        };
      }, function(module, exports, __webpack_require__) {
        module.exports = {
          "default": __webpack_require__(53),
          __esModule: true
        };
      }, function(module, exports, __webpack_require__) {
        __webpack_require__(4);
        __webpack_require__(42);
        module.exports = __webpack_require__(20)('iterator');
      }, function(module, exports, __webpack_require__) {
        (function(global) {
          var g = typeof global === "object" ? global : typeof window === "object" ? window : typeof self === "object" ? self : this;
          var hadRuntime = g.regeneratorRuntime && Object.getOwnPropertyNames(g).indexOf("regeneratorRuntime") >= 0;
          var oldRuntime = hadRuntime && g.regeneratorRuntime;
          g.regeneratorRuntime = undefined;
          module.exports = __webpack_require__(55);
          if (hadRuntime) {
            g.regeneratorRuntime = oldRuntime;
          } else {
            try {
              delete g.regeneratorRuntime;
            } catch (e) {
              g.regeneratorRuntime = undefined;
            }
          }
          module.exports = {
            "default": module.exports,
            __esModule: true
          };
        }.call(exports, (function() {
          return this;
        }())));
      }, function(module, exports, __webpack_require__) {
        (function(global, process) {
          "use strict";
          var _Symbol = __webpack_require__(57)["default"];
          var _Symbol$iterator = __webpack_require__(52)["default"];
          var _Object$create = __webpack_require__(63)["default"];
          var _Promise = __webpack_require__(65)["default"];
          !(function(global) {
            "use strict";
            var hasOwn = Object.prototype.hasOwnProperty;
            var undefined;
            var iteratorSymbol = typeof _Symbol === "function" && _Symbol$iterator || "@@iterator";
            var inModule = typeof module === "object";
            var runtime = global.regeneratorRuntime;
            if (runtime) {
              if (inModule) {
                module.exports = runtime;
              }
              return;
            }
            runtime = global.regeneratorRuntime = inModule ? module.exports : {};
            function wrap(innerFn, outerFn, self, tryLocsList) {
              var generator = _Object$create((outerFn || Generator).prototype);
              generator._invoke = makeInvokeMethod(innerFn, self || null, new Context(tryLocsList || []));
              return generator;
            }
            runtime.wrap = wrap;
            function tryCatch(fn, obj, arg) {
              try {
                return {
                  type: "normal",
                  arg: fn.call(obj, arg)
                };
              } catch (err) {
                return {
                  type: "throw",
                  arg: err
                };
              }
            }
            var GenStateSuspendedStart = "suspendedStart";
            var GenStateSuspendedYield = "suspendedYield";
            var GenStateExecuting = "executing";
            var GenStateCompleted = "completed";
            var ContinueSentinel = {};
            function Generator() {}
            function GeneratorFunction() {}
            function GeneratorFunctionPrototype() {}
            var Gp = GeneratorFunctionPrototype.prototype = Generator.prototype;
            GeneratorFunction.prototype = Gp.constructor = GeneratorFunctionPrototype;
            GeneratorFunctionPrototype.constructor = GeneratorFunction;
            GeneratorFunction.displayName = "GeneratorFunction";
            function defineIteratorMethods(prototype) {
              ["next", "throw", "return"].forEach(function(method) {
                prototype[method] = function(arg) {
                  return this._invoke(method, arg);
                };
              });
            }
            runtime.isGeneratorFunction = function(genFun) {
              var ctor = typeof genFun === "function" && genFun.constructor;
              return ctor ? ctor === GeneratorFunction || (ctor.displayName || ctor.name) === "GeneratorFunction" : false;
            };
            runtime.mark = function(genFun) {
              genFun.__proto__ = GeneratorFunctionPrototype;
              genFun.prototype = _Object$create(Gp);
              return genFun;
            };
            runtime.awrap = function(arg) {
              return new AwaitArgument(arg);
            };
            function AwaitArgument(arg) {
              this.arg = arg;
            }
            function AsyncIterator(generator) {
              function invoke(method, arg) {
                var result = generator[method](arg);
                var value = result.value;
                return value instanceof AwaitArgument ? _Promise.resolve(value.arg).then(invokeNext, invokeThrow) : _Promise.resolve(value).then(function(unwrapped) {
                  result.value = unwrapped;
                  return result;
                });
              }
              if (typeof process === "object" && process.domain) {
                invoke = process.domain.bind(invoke);
              }
              var invokeNext = invoke.bind(generator, "next");
              var invokeThrow = invoke.bind(generator, "throw");
              var invokeReturn = invoke.bind(generator, "return");
              var previousPromise;
              function enqueue(method, arg) {
                var enqueueResult = previousPromise ? previousPromise.then(function() {
                  return invoke(method, arg);
                }) : new _Promise(function(resolve) {
                  resolve(invoke(method, arg));
                });
                previousPromise = enqueueResult["catch"](function(ignored) {});
                return enqueueResult;
              }
              this._invoke = enqueue;
            }
            defineIteratorMethods(AsyncIterator.prototype);
            runtime.async = function(innerFn, outerFn, self, tryLocsList) {
              var iter = new AsyncIterator(wrap(innerFn, outerFn, self, tryLocsList));
              return runtime.isGeneratorFunction(outerFn) ? iter : iter.next().then(function(result) {
                return result.done ? result.value : iter.next();
              });
            };
            function makeInvokeMethod(innerFn, self, context) {
              var state = GenStateSuspendedStart;
              return function invoke(method, arg) {
                if (state === GenStateExecuting) {
                  throw new Error("Generator is already running");
                }
                if (state === GenStateCompleted) {
                  if (method === "throw") {
                    throw arg;
                  }
                  return doneResult();
                }
                while (true) {
                  var delegate = context.delegate;
                  if (delegate) {
                    if (method === "return" || method === "throw" && delegate.iterator[method] === undefined) {
                      context.delegate = null;
                      var returnMethod = delegate.iterator["return"];
                      if (returnMethod) {
                        var record = tryCatch(returnMethod, delegate.iterator, arg);
                        if (record.type === "throw") {
                          method = "throw";
                          arg = record.arg;
                          continue;
                        }
                      }
                      if (method === "return") {
                        continue;
                      }
                    }
                    var record = tryCatch(delegate.iterator[method], delegate.iterator, arg);
                    if (record.type === "throw") {
                      context.delegate = null;
                      method = "throw";
                      arg = record.arg;
                      continue;
                    }
                    method = "next";
                    arg = undefined;
                    var info = record.arg;
                    if (info.done) {
                      context[delegate.resultName] = info.value;
                      context.next = delegate.nextLoc;
                    } else {
                      state = GenStateSuspendedYield;
                      return info;
                    }
                    context.delegate = null;
                  }
                  if (method === "next") {
                    if (state === GenStateSuspendedYield) {
                      context.sent = arg;
                    } else {
                      context.sent = undefined;
                    }
                  } else if (method === "throw") {
                    if (state === GenStateSuspendedStart) {
                      state = GenStateCompleted;
                      throw arg;
                    }
                    if (context.dispatchException(arg)) {
                      method = "next";
                      arg = undefined;
                    }
                  } else if (method === "return") {
                    context.abrupt("return", arg);
                  }
                  state = GenStateExecuting;
                  var record = tryCatch(innerFn, self, context);
                  if (record.type === "normal") {
                    state = context.done ? GenStateCompleted : GenStateSuspendedYield;
                    var info = {
                      value: record.arg,
                      done: context.done
                    };
                    if (record.arg === ContinueSentinel) {
                      if (context.delegate && method === "next") {
                        arg = undefined;
                      }
                    } else {
                      return info;
                    }
                  } else if (record.type === "throw") {
                    state = GenStateCompleted;
                    method = "throw";
                    arg = record.arg;
                  }
                }
              };
            }
            defineIteratorMethods(Gp);
            Gp[iteratorSymbol] = function() {
              return this;
            };
            Gp.toString = function() {
              return "[object Generator]";
            };
            function pushTryEntry(locs) {
              var entry = {tryLoc: locs[0]};
              if (1 in locs) {
                entry.catchLoc = locs[1];
              }
              if (2 in locs) {
                entry.finallyLoc = locs[2];
                entry.afterLoc = locs[3];
              }
              this.tryEntries.push(entry);
            }
            function resetTryEntry(entry) {
              var record = entry.completion || {};
              record.type = "normal";
              delete record.arg;
              entry.completion = record;
            }
            function Context(tryLocsList) {
              this.tryEntries = [{tryLoc: "root"}];
              tryLocsList.forEach(pushTryEntry, this);
              this.reset(true);
            }
            runtime.keys = function(object) {
              var keys = [];
              for (var key in object) {
                keys.push(key);
              }
              keys.reverse();
              return function next() {
                while (keys.length) {
                  var key = keys.pop();
                  if (key in object) {
                    next.value = key;
                    next.done = false;
                    return next;
                  }
                }
                next.done = true;
                return next;
              };
            };
            function values(iterable) {
              if (iterable) {
                var iteratorMethod = iterable[iteratorSymbol];
                if (iteratorMethod) {
                  return iteratorMethod.call(iterable);
                }
                if (typeof iterable.next === "function") {
                  return iterable;
                }
                if (!isNaN(iterable.length)) {
                  var i = -1,
                      next = function next() {
                        while (++i < iterable.length) {
                          if (hasOwn.call(iterable, i)) {
                            next.value = iterable[i];
                            next.done = false;
                            return next;
                          }
                        }
                        next.value = undefined;
                        next.done = true;
                        return next;
                      };
                  return next.next = next;
                }
              }
              return {next: doneResult};
            }
            runtime.values = values;
            function doneResult() {
              return {
                value: undefined,
                done: true
              };
            }
            Context.prototype = {
              constructor: Context,
              reset: function reset(skipTempReset) {
                this.prev = 0;
                this.next = 0;
                this.sent = undefined;
                this.done = false;
                this.delegate = null;
                this.tryEntries.forEach(resetTryEntry);
                if (!skipTempReset) {
                  for (var name in this) {
                    if (name.charAt(0) === "t" && hasOwn.call(this, name) && !isNaN(+name.slice(1))) {
                      this[name] = undefined;
                    }
                  }
                }
              },
              stop: function stop() {
                this.done = true;
                var rootEntry = this.tryEntries[0];
                var rootRecord = rootEntry.completion;
                if (rootRecord.type === "throw") {
                  throw rootRecord.arg;
                }
                return this.rval;
              },
              dispatchException: function dispatchException(exception) {
                if (this.done) {
                  throw exception;
                }
                var context = this;
                function handle(loc, caught) {
                  record.type = "throw";
                  record.arg = exception;
                  context.next = loc;
                  return !!caught;
                }
                for (var i = this.tryEntries.length - 1; i >= 0; --i) {
                  var entry = this.tryEntries[i];
                  var record = entry.completion;
                  if (entry.tryLoc === "root") {
                    return handle("end");
                  }
                  if (entry.tryLoc <= this.prev) {
                    var hasCatch = hasOwn.call(entry, "catchLoc");
                    var hasFinally = hasOwn.call(entry, "finallyLoc");
                    if (hasCatch && hasFinally) {
                      if (this.prev < entry.catchLoc) {
                        return handle(entry.catchLoc, true);
                      } else if (this.prev < entry.finallyLoc) {
                        return handle(entry.finallyLoc);
                      }
                    } else if (hasCatch) {
                      if (this.prev < entry.catchLoc) {
                        return handle(entry.catchLoc, true);
                      }
                    } else if (hasFinally) {
                      if (this.prev < entry.finallyLoc) {
                        return handle(entry.finallyLoc);
                      }
                    } else {
                      throw new Error("try statement without catch or finally");
                    }
                  }
                }
              },
              abrupt: function abrupt(type, arg) {
                for (var i = this.tryEntries.length - 1; i >= 0; --i) {
                  var entry = this.tryEntries[i];
                  if (entry.tryLoc <= this.prev && hasOwn.call(entry, "finallyLoc") && this.prev < entry.finallyLoc) {
                    var finallyEntry = entry;
                    break;
                  }
                }
                if (finallyEntry && (type === "break" || type === "continue") && finallyEntry.tryLoc <= arg && arg <= finallyEntry.finallyLoc) {
                  finallyEntry = null;
                }
                var record = finallyEntry ? finallyEntry.completion : {};
                record.type = type;
                record.arg = arg;
                if (finallyEntry) {
                  this.next = finallyEntry.finallyLoc;
                } else {
                  this.complete(record);
                }
                return ContinueSentinel;
              },
              complete: function complete(record, afterLoc) {
                if (record.type === "throw") {
                  throw record.arg;
                }
                if (record.type === "break" || record.type === "continue") {
                  this.next = record.arg;
                } else if (record.type === "return") {
                  this.rval = record.arg;
                  this.next = "end";
                } else if (record.type === "normal" && afterLoc) {
                  this.next = afterLoc;
                }
              },
              finish: function finish(finallyLoc) {
                for (var i = this.tryEntries.length - 1; i >= 0; --i) {
                  var entry = this.tryEntries[i];
                  if (entry.finallyLoc === finallyLoc) {
                    this.complete(entry.completion, entry.afterLoc);
                    resetTryEntry(entry);
                    return ContinueSentinel;
                  }
                }
              },
              "catch": function _catch(tryLoc) {
                for (var i = this.tryEntries.length - 1; i >= 0; --i) {
                  var entry = this.tryEntries[i];
                  if (entry.tryLoc === tryLoc) {
                    var record = entry.completion;
                    if (record.type === "throw") {
                      var thrown = record.arg;
                      resetTryEntry(entry);
                    }
                    return thrown;
                  }
                }
                throw new Error("illegal catch attempt");
              },
              delegateYield: function delegateYield(iterable, resultName, nextLoc) {
                this.delegate = {
                  iterator: values(iterable),
                  resultName: resultName,
                  nextLoc: nextLoc
                };
                return ContinueSentinel;
              }
            };
          })(typeof global === "object" ? global : typeof window === "object" ? window : typeof self === "object" ? self : undefined);
        }.call(exports, (function() {
          return this;
        }()), __webpack_require__(56)));
      }, function(module, exports) {
        var process = module.exports = {};
        var queue = [];
        var draining = false;
        var currentQueue;
        var queueIndex = -1;
        function cleanUpNextTick() {
          draining = false;
          if (currentQueue.length) {
            queue = currentQueue.concat(queue);
          } else {
            queueIndex = -1;
          }
          if (queue.length) {
            drainQueue();
          }
        }
        function drainQueue() {
          if (draining) {
            return;
          }
          var timeout = setTimeout(cleanUpNextTick);
          draining = true;
          var len = queue.length;
          while (len) {
            currentQueue = queue;
            queue = [];
            while (++queueIndex < len) {
              if (currentQueue) {
                currentQueue[queueIndex].run();
              }
            }
            queueIndex = -1;
            len = queue.length;
          }
          currentQueue = null;
          draining = false;
          clearTimeout(timeout);
        }
        process.nextTick = function(fun) {
          var args = new Array(arguments.length - 1);
          if (arguments.length > 1) {
            for (var i = 1; i < arguments.length; i++) {
              args[i - 1] = arguments[i];
            }
          }
          queue.push(new Item(fun, args));
          if (queue.length === 1 && !draining) {
            setTimeout(drainQueue, 0);
          }
        };
        function Item(fun, array) {
          this.fun = fun;
          this.array = array;
        }
        Item.prototype.run = function() {
          this.fun.apply(null, this.array);
        };
        process.title = 'browser';
        process.browser = true;
        process.env = {};
        process.argv = [];
        process.version = '';
        process.versions = {};
        function noop() {}
        process.on = noop;
        process.addListener = noop;
        process.once = noop;
        process.off = noop;
        process.removeListener = noop;
        process.removeAllListeners = noop;
        process.emit = noop;
        process.binding = function(name) {
          throw new Error('process.binding is not supported');
        };
        process.cwd = function() {
          return '/';
        };
        process.chdir = function(dir) {
          throw new Error('process.chdir is not supported');
        };
        process.umask = function() {
          return 0;
        };
      }, function(module, exports, __webpack_require__) {
        module.exports = {
          "default": __webpack_require__(58),
          __esModule: true
        };
      }, function(module, exports, __webpack_require__) {
        __webpack_require__(59);
        module.exports = __webpack_require__(12).Symbol;
      }, function(module, exports, __webpack_require__) {
        'use strict';
        var $ = __webpack_require__(15),
            global = __webpack_require__(11),
            has = __webpack_require__(19),
            SUPPORT_DESC = __webpack_require__(17),
            $def = __webpack_require__(10),
            $redef = __webpack_require__(13),
            $fails = __webpack_require__(18),
            shared = __webpack_require__(21),
            setTag = __webpack_require__(25),
            uid = __webpack_require__(22),
            wks = __webpack_require__(20),
            keyOf = __webpack_require__(60),
            $names = __webpack_require__(61),
            enumKeys = __webpack_require__(62),
            isObject = __webpack_require__(32),
            anObject = __webpack_require__(31),
            toIObject = __webpack_require__(46),
            createDesc = __webpack_require__(16),
            getDesc = $.getDesc,
            setDesc = $.setDesc,
            _create = $.create,
            getNames = $names.get,
            $Symbol = global.Symbol,
            setter = false,
            HIDDEN = wks('_hidden'),
            isEnum = $.isEnum,
            SymbolRegistry = shared('symbol-registry'),
            AllSymbols = shared('symbols'),
            useNative = typeof $Symbol == 'function',
            ObjectProto = Object.prototype;
        var setSymbolDesc = SUPPORT_DESC && $fails(function() {
          return _create(setDesc({}, 'a', {get: function() {
              return setDesc(this, 'a', {value: 7}).a;
            }})).a != 7;
        }) ? function(it, key, D) {
          var protoDesc = getDesc(ObjectProto, key);
          if (protoDesc)
            delete ObjectProto[key];
          setDesc(it, key, D);
          if (protoDesc && it !== ObjectProto)
            setDesc(ObjectProto, key, protoDesc);
        } : setDesc;
        var wrap = function(tag) {
          var sym = AllSymbols[tag] = _create($Symbol.prototype);
          sym._k = tag;
          SUPPORT_DESC && setter && setSymbolDesc(ObjectProto, tag, {
            configurable: true,
            set: function(value) {
              if (has(this, HIDDEN) && has(this[HIDDEN], tag))
                this[HIDDEN][tag] = false;
              setSymbolDesc(this, tag, createDesc(1, value));
            }
          });
          return sym;
        };
        var $defineProperty = function defineProperty(it, key, D) {
          if (D && has(AllSymbols, key)) {
            if (!D.enumerable) {
              if (!has(it, HIDDEN))
                setDesc(it, HIDDEN, createDesc(1, {}));
              it[HIDDEN][key] = true;
            } else {
              if (has(it, HIDDEN) && it[HIDDEN][key])
                it[HIDDEN][key] = false;
              D = _create(D, {enumerable: createDesc(0, false)});
            }
            return setSymbolDesc(it, key, D);
          }
          return setDesc(it, key, D);
        };
        var $defineProperties = function defineProperties(it, P) {
          anObject(it);
          var keys = enumKeys(P = toIObject(P)),
              i = 0,
              l = keys.length,
              key;
          while (l > i)
            $defineProperty(it, key = keys[i++], P[key]);
          return it;
        };
        var $create = function create(it, P) {
          return P === undefined ? _create(it) : $defineProperties(_create(it), P);
        };
        var $propertyIsEnumerable = function propertyIsEnumerable(key) {
          var E = isEnum.call(this, key);
          return E || !has(this, key) || !has(AllSymbols, key) || has(this, HIDDEN) && this[HIDDEN][key] ? E : true;
        };
        var $getOwnPropertyDescriptor = function getOwnPropertyDescriptor(it, key) {
          var D = getDesc(it = toIObject(it), key);
          if (D && has(AllSymbols, key) && !(has(it, HIDDEN) && it[HIDDEN][key]))
            D.enumerable = true;
          return D;
        };
        var $getOwnPropertyNames = function getOwnPropertyNames(it) {
          var names = getNames(toIObject(it)),
              result = [],
              i = 0,
              key;
          while (names.length > i)
            if (!has(AllSymbols, key = names[i++]) && key != HIDDEN)
              result.push(key);
          return result;
        };
        var $getOwnPropertySymbols = function getOwnPropertySymbols(it) {
          var names = getNames(toIObject(it)),
              result = [],
              i = 0,
              key;
          while (names.length > i)
            if (has(AllSymbols, key = names[i++]))
              result.push(AllSymbols[key]);
          return result;
        };
        if (!useNative) {
          $Symbol = function Symbol() {
            if (this instanceof $Symbol)
              throw TypeError('Symbol is not a constructor');
            return wrap(uid(arguments[0]));
          };
          $redef($Symbol.prototype, 'toString', function toString() {
            return this._k;
          });
          $.create = $create;
          $.isEnum = $propertyIsEnumerable;
          $.getDesc = $getOwnPropertyDescriptor;
          $.setDesc = $defineProperty;
          $.setDescs = $defineProperties;
          $.getNames = $names.get = $getOwnPropertyNames;
          $.getSymbols = $getOwnPropertySymbols;
          if (SUPPORT_DESC && !__webpack_require__(9)) {
            $redef(ObjectProto, 'propertyIsEnumerable', $propertyIsEnumerable, true);
          }
        }
        if (!useNative || $fails(function() {
          return JSON.stringify([$Symbol()]) != '[null]';
        }))
          $redef($Symbol.prototype, 'toJSON', function toJSON() {
            if (useNative && isObject(this))
              return this;
          });
        var symbolStatics = {
          'for': function(key) {
            return has(SymbolRegistry, key += '') ? SymbolRegistry[key] : SymbolRegistry[key] = $Symbol(key);
          },
          keyFor: function keyFor(key) {
            return keyOf(SymbolRegistry, key);
          },
          useSetter: function() {
            setter = true;
          },
          useSimple: function() {
            setter = false;
          }
        };
        $.each.call(('hasInstance,isConcatSpreadable,iterator,match,replace,search,' + 'species,split,toPrimitive,toStringTag,unscopables').split(','), function(it) {
          var sym = wks(it);
          symbolStatics[it] = useNative ? sym : wrap(sym);
        });
        setter = true;
        $def($def.G + $def.W, {Symbol: $Symbol});
        $def($def.S, 'Symbol', symbolStatics);
        $def($def.S + $def.F * !useNative, 'Object', {
          create: $create,
          defineProperty: $defineProperty,
          defineProperties: $defineProperties,
          getOwnPropertyDescriptor: $getOwnPropertyDescriptor,
          getOwnPropertyNames: $getOwnPropertyNames,
          getOwnPropertySymbols: $getOwnPropertySymbols
        });
        setTag($Symbol, 'Symbol');
        setTag(Math, 'Math', true);
        setTag(global.JSON, 'JSON', true);
      }, function(module, exports, __webpack_require__) {
        var $ = __webpack_require__(15),
            toIObject = __webpack_require__(46);
        module.exports = function(object, el) {
          var O = toIObject(object),
              keys = $.getKeys(O),
              length = keys.length,
              index = 0,
              key;
          while (length > index)
            if (O[key = keys[index++]] === el)
              return key;
        };
      }, function(module, exports, __webpack_require__) {
        var toString = {}.toString,
            toIObject = __webpack_require__(46),
            getNames = __webpack_require__(15).getNames;
        var windowNames = typeof window == 'object' && Object.getOwnPropertyNames ? Object.getOwnPropertyNames(window) : [];
        var getWindowNames = function(it) {
          try {
            return getNames(it);
          } catch (e) {
            return windowNames.slice();
          }
        };
        module.exports.get = function getOwnPropertyNames(it) {
          if (windowNames && toString.call(it) == '[object Window]')
            return getWindowNames(it);
          return getNames(toIObject(it));
        };
      }, function(module, exports, __webpack_require__) {
        var $ = __webpack_require__(15);
        module.exports = function(it) {
          var keys = $.getKeys(it),
              getSymbols = $.getSymbols;
          if (getSymbols) {
            var symbols = getSymbols(it),
                isEnum = $.isEnum,
                i = 0,
                key;
            while (symbols.length > i)
              if (isEnum.call(it, key = symbols[i++]))
                keys.push(key);
          }
          return keys;
        };
      }, function(module, exports, __webpack_require__) {
        module.exports = {
          "default": __webpack_require__(64),
          __esModule: true
        };
      }, function(module, exports, __webpack_require__) {
        var $ = __webpack_require__(15);
        module.exports = function create(P, D) {
          return $.create(P, D);
        };
      }, function(module, exports, __webpack_require__) {
        module.exports = {
          "default": __webpack_require__(66),
          __esModule: true
        };
      }, function(module, exports, __webpack_require__) {
        __webpack_require__(67);
        __webpack_require__(4);
        __webpack_require__(42);
        __webpack_require__(68);
        module.exports = __webpack_require__(12).Promise;
      }, function(module, exports) {}, function(module, exports, __webpack_require__) {
        'use strict';
        var $ = __webpack_require__(15),
            LIBRARY = __webpack_require__(9),
            global = __webpack_require__(11),
            ctx = __webpack_require__(27),
            classof = __webpack_require__(36),
            $def = __webpack_require__(10),
            isObject = __webpack_require__(32),
            anObject = __webpack_require__(31),
            aFunction = __webpack_require__(28),
            strictNew = __webpack_require__(69),
            forOf = __webpack_require__(70),
            setProto = __webpack_require__(71).set,
            same = __webpack_require__(72),
            species = __webpack_require__(73),
            SPECIES = __webpack_require__(20)('species'),
            RECORD = __webpack_require__(22)('record'),
            asap = __webpack_require__(74),
            PROMISE = 'Promise',
            process = global.process,
            isNode = classof(process) == 'process',
            P = global[PROMISE],
            Wrapper;
        var testResolve = function(sub) {
          var test = new P(function() {});
          if (sub)
            test.constructor = Object;
          return P.resolve(test) === test;
        };
        var useNative = function() {
          var works = false;
          function P2(x) {
            var self = new P(x);
            setProto(self, P2.prototype);
            return self;
          }
          try {
            works = P && P.resolve && testResolve();
            setProto(P2, P);
            P2.prototype = $.create(P.prototype, {constructor: {value: P2}});
            if (!(P2.resolve(5).then(function() {}) instanceof P2)) {
              works = false;
            }
            if (works && __webpack_require__(17)) {
              var thenableThenGotten = false;
              P.resolve($.setDesc({}, 'then', {get: function() {
                  thenableThenGotten = true;
                }}));
              works = thenableThenGotten;
            }
          } catch (e) {
            works = false;
          }
          return works;
        }();
        var isPromise = function(it) {
          return isObject(it) && (useNative ? classof(it) == 'Promise' : RECORD in it);
        };
        var sameConstructor = function(a, b) {
          if (LIBRARY && a === P && b === Wrapper)
            return true;
          return same(a, b);
        };
        var getConstructor = function(C) {
          var S = anObject(C)[SPECIES];
          return S != undefined ? S : C;
        };
        var isThenable = function(it) {
          var then;
          return isObject(it) && typeof(then = it.then) == 'function' ? then : false;
        };
        var notify = function(record, isReject) {
          if (record.n)
            return;
          record.n = true;
          var chain = record.c;
          asap(function() {
            var value = record.v,
                ok = record.s == 1,
                i = 0;
            var run = function(react) {
              var cb = ok ? react.ok : react.fail,
                  ret,
                  then;
              try {
                if (cb) {
                  if (!ok)
                    record.h = true;
                  ret = cb === true ? value : cb(value);
                  if (ret === react.P) {
                    react.rej(TypeError('Promise-chain cycle'));
                  } else if (then = isThenable(ret)) {
                    then.call(ret, react.res, react.rej);
                  } else
                    react.res(ret);
                } else
                  react.rej(value);
              } catch (err) {
                react.rej(err);
              }
            };
            while (chain.length > i)
              run(chain[i++]);
            chain.length = 0;
            record.n = false;
            if (isReject)
              setTimeout(function() {
                var promise = record.p,
                    handler,
                    console;
                if (isUnhandled(promise)) {
                  if (isNode) {
                    process.emit('unhandledRejection', value, promise);
                  } else if (handler = global.onunhandledrejection) {
                    handler({
                      promise: promise,
                      reason: value
                    });
                  } else if ((console = global.console) && console.error) {
                    console.error('Unhandled promise rejection', value);
                  }
                }
                record.a = undefined;
              }, 1);
          });
        };
        var isUnhandled = function(promise) {
          var record = promise[RECORD],
              chain = record.a || record.c,
              i = 0,
              react;
          if (record.h)
            return false;
          while (chain.length > i) {
            react = chain[i++];
            if (react.fail || !isUnhandled(react.P))
              return false;
          }
          return true;
        };
        var $reject = function(value) {
          var record = this;
          if (record.d)
            return;
          record.d = true;
          record = record.r || record;
          record.v = value;
          record.s = 2;
          record.a = record.c.slice();
          notify(record, true);
        };
        var $resolve = function(value) {
          var record = this,
              then;
          if (record.d)
            return;
          record.d = true;
          record = record.r || record;
          try {
            if (then = isThenable(value)) {
              asap(function() {
                var wrapper = {
                  r: record,
                  d: false
                };
                try {
                  then.call(value, ctx($resolve, wrapper, 1), ctx($reject, wrapper, 1));
                } catch (e) {
                  $reject.call(wrapper, e);
                }
              });
            } else {
              record.v = value;
              record.s = 1;
              notify(record, false);
            }
          } catch (e) {
            $reject.call({
              r: record,
              d: false
            }, e);
          }
        };
        if (!useNative) {
          P = function Promise(executor) {
            aFunction(executor);
            var record = {
              p: strictNew(this, P, PROMISE),
              c: [],
              a: undefined,
              s: 0,
              d: false,
              v: undefined,
              h: false,
              n: false
            };
            this[RECORD] = record;
            try {
              executor(ctx($resolve, record, 1), ctx($reject, record, 1));
            } catch (err) {
              $reject.call(record, err);
            }
          };
          __webpack_require__(79)(P.prototype, {
            then: function then(onFulfilled, onRejected) {
              var S = anObject(anObject(this).constructor)[SPECIES];
              var react = {
                ok: typeof onFulfilled == 'function' ? onFulfilled : true,
                fail: typeof onRejected == 'function' ? onRejected : false
              };
              var promise = react.P = new (S != undefined ? S : P)(function(res, rej) {
                react.res = res;
                react.rej = rej;
              });
              aFunction(react.res);
              aFunction(react.rej);
              var record = this[RECORD];
              record.c.push(react);
              if (record.a)
                record.a.push(react);
              if (record.s)
                notify(record, false);
              return promise;
            },
            'catch': function(onRejected) {
              return this.then(undefined, onRejected);
            }
          });
        }
        $def($def.G + $def.W + $def.F * !useNative, {Promise: P});
        __webpack_require__(25)(P, PROMISE);
        species(P);
        species(Wrapper = __webpack_require__(12)[PROMISE]);
        $def($def.S + $def.F * !useNative, PROMISE, {reject: function reject(r) {
            return new this(function(res, rej) {
              rej(r);
            });
          }});
        $def($def.S + $def.F * (!useNative || testResolve(true)), PROMISE, {resolve: function resolve(x) {
            return isPromise(x) && sameConstructor(x.constructor, this) ? x : new this(function(res) {
              res(x);
            });
          }});
        $def($def.S + $def.F * !(useNative && __webpack_require__(38)(function(iter) {
          P.all(iter)['catch'](function() {});
        })), PROMISE, {
          all: function all(iterable) {
            var C = getConstructor(this),
                values = [];
            return new C(function(res, rej) {
              forOf(iterable, false, values.push, values);
              var remaining = values.length,
                  results = Array(remaining);
              if (remaining)
                $.each.call(values, function(promise, index) {
                  C.resolve(promise).then(function(value) {
                    results[index] = value;
                    --remaining || res(results);
                  }, rej);
                });
              else
                res(results);
            });
          },
          race: function race(iterable) {
            var C = getConstructor(this);
            return new C(function(res, rej) {
              forOf(iterable, false, function(promise) {
                C.resolve(promise).then(res, rej);
              });
            });
          }
        });
      }, function(module, exports) {
        module.exports = function(it, Constructor, name) {
          if (!(it instanceof Constructor))
            throw TypeError(name + ": use the 'new' operator!");
          return it;
        };
      }, function(module, exports, __webpack_require__) {
        var ctx = __webpack_require__(27),
            call = __webpack_require__(30),
            isArrayIter = __webpack_require__(33),
            anObject = __webpack_require__(31),
            toLength = __webpack_require__(34),
            getIterFn = __webpack_require__(35);
        module.exports = function(iterable, entries, fn, that) {
          var iterFn = getIterFn(iterable),
              f = ctx(fn, that, entries ? 2 : 1),
              index = 0,
              length,
              step,
              iterator;
          if (typeof iterFn != 'function')
            throw TypeError(iterable + ' is not iterable!');
          if (isArrayIter(iterFn))
            for (length = toLength(iterable.length); length > index; index++) {
              entries ? f(anObject(step = iterable[index])[0], step[1]) : f(iterable[index]);
            }
          else
            for (iterator = iterFn.call(iterable); !(step = iterator.next()).done; ) {
              call(iterator, f, step.value, entries);
            }
        };
      }, function(module, exports, __webpack_require__) {
        var getDesc = __webpack_require__(15).getDesc,
            isObject = __webpack_require__(32),
            anObject = __webpack_require__(31);
        var check = function(O, proto) {
          anObject(O);
          if (!isObject(proto) && proto !== null)
            throw TypeError(proto + ": can't set as prototype!");
        };
        module.exports = {
          set: Object.setPrototypeOf || ('__proto__' in {} ? function(test, buggy, set) {
            try {
              set = __webpack_require__(27)(Function.call, getDesc(Object.prototype, '__proto__').set, 2);
              set(test, []);
              buggy = !(test instanceof Array);
            } catch (e) {
              buggy = true;
            }
            return function setPrototypeOf(O, proto) {
              check(O, proto);
              if (buggy)
                O.__proto__ = proto;
              else
                set(O, proto);
              return O;
            };
          }({}, false) : undefined),
          check: check
        };
      }, function(module, exports) {
        module.exports = Object.is || function is(x, y) {
          return x === y ? x !== 0 || 1 / x === 1 / y : x != x && y != y;
        };
      }, function(module, exports, __webpack_require__) {
        'use strict';
        var $ = __webpack_require__(15),
            SPECIES = __webpack_require__(20)('species');
        module.exports = function(C) {
          if (__webpack_require__(17) && !(SPECIES in C))
            $.setDesc(C, SPECIES, {
              configurable: true,
              get: function() {
                return this;
              }
            });
        };
      }, function(module, exports, __webpack_require__) {
        var global = __webpack_require__(11),
            macrotask = __webpack_require__(75).set,
            Observer = global.MutationObserver || global.WebKitMutationObserver,
            process = global.process,
            isNode = __webpack_require__(37)(process) == 'process',
            head,
            last,
            notify;
        var flush = function() {
          var parent,
              domain;
          if (isNode && (parent = process.domain)) {
            process.domain = null;
            parent.exit();
          }
          while (head) {
            domain = head.domain;
            if (domain)
              domain.enter();
            head.fn.call();
            if (domain)
              domain.exit();
            head = head.next;
          }
          last = undefined;
          if (parent)
            parent.enter();
        };
        if (isNode) {
          notify = function() {
            process.nextTick(flush);
          };
        } else if (Observer) {
          var toggle = 1,
              node = document.createTextNode('');
          new Observer(flush).observe(node, {characterData: true});
          notify = function() {
            node.data = toggle = -toggle;
          };
        } else {
          notify = function() {
            macrotask.call(global, flush);
          };
        }
        module.exports = function asap(fn) {
          var task = {
            fn: fn,
            next: undefined,
            domain: isNode && process.domain
          };
          if (last)
            last.next = task;
          if (!head) {
            head = task;
            notify();
          }
          last = task;
        };
      }, function(module, exports, __webpack_require__) {
        'use strict';
        var ctx = __webpack_require__(27),
            invoke = __webpack_require__(76),
            html = __webpack_require__(77),
            cel = __webpack_require__(78),
            global = __webpack_require__(11),
            process = global.process,
            setTask = global.setImmediate,
            clearTask = global.clearImmediate,
            MessageChannel = global.MessageChannel,
            counter = 0,
            queue = {},
            ONREADYSTATECHANGE = 'onreadystatechange',
            defer,
            channel,
            port;
        var run = function() {
          var id = +this;
          if (queue.hasOwnProperty(id)) {
            var fn = queue[id];
            delete queue[id];
            fn();
          }
        };
        var listner = function(event) {
          run.call(event.data);
        };
        if (!setTask || !clearTask) {
          setTask = function setImmediate(fn) {
            var args = [],
                i = 1;
            while (arguments.length > i)
              args.push(arguments[i++]);
            queue[++counter] = function() {
              invoke(typeof fn == 'function' ? fn : Function(fn), args);
            };
            defer(counter);
            return counter;
          };
          clearTask = function clearImmediate(id) {
            delete queue[id];
          };
          if (__webpack_require__(37)(process) == 'process') {
            defer = function(id) {
              process.nextTick(ctx(run, id, 1));
            };
          } else if (MessageChannel) {
            channel = new MessageChannel;
            port = channel.port2;
            channel.port1.onmessage = listner;
            defer = ctx(port.postMessage, port, 1);
          } else if (global.addEventListener && typeof postMessage == 'function' && !global.importScript) {
            defer = function(id) {
              global.postMessage(id + '', '*');
            };
            global.addEventListener('message', listner, false);
          } else if (ONREADYSTATECHANGE in cel('script')) {
            defer = function(id) {
              html.appendChild(cel('script'))[ONREADYSTATECHANGE] = function() {
                html.removeChild(this);
                run.call(id);
              };
            };
          } else {
            defer = function(id) {
              setTimeout(ctx(run, id, 1), 0);
            };
          }
        }
        module.exports = {
          set: setTask,
          clear: clearTask
        };
      }, function(module, exports) {
        module.exports = function(fn, args, that) {
          var un = that === undefined;
          switch (args.length) {
            case 0:
              return un ? fn() : fn.call(that);
            case 1:
              return un ? fn(args[0]) : fn.call(that, args[0]);
            case 2:
              return un ? fn(args[0], args[1]) : fn.call(that, args[0], args[1]);
            case 3:
              return un ? fn(args[0], args[1], args[2]) : fn.call(that, args[0], args[1], args[2]);
            case 4:
              return un ? fn(args[0], args[1], args[2], args[3]) : fn.call(that, args[0], args[1], args[2], args[3]);
          }
          return fn.apply(that, args);
        };
      }, function(module, exports, __webpack_require__) {
        module.exports = __webpack_require__(11).document && document.documentElement;
      }, function(module, exports, __webpack_require__) {
        var isObject = __webpack_require__(32),
            document = __webpack_require__(11).document,
            is = isObject(document) && isObject(document.createElement);
        module.exports = function(it) {
          return is ? document.createElement(it) : {};
        };
      }, function(module, exports, __webpack_require__) {
        var $redef = __webpack_require__(13);
        module.exports = function(target, src) {
          for (var key in src)
            $redef(target, key, src[key]);
          return target;
        };
      }, function(module, exports, __webpack_require__) {
        module.exports = {
          "default": __webpack_require__(81),
          __esModule: true
        };
      }, function(module, exports, __webpack_require__) {
        __webpack_require__(82);
        module.exports = __webpack_require__(12).Object.keys;
      }, function(module, exports, __webpack_require__) {
        var toObject = __webpack_require__(29);
        __webpack_require__(83)('keys', function($keys) {
          return function keys(it) {
            return $keys(toObject(it));
          };
        });
      }, function(module, exports, __webpack_require__) {
        module.exports = function(KEY, exec) {
          var $def = __webpack_require__(10),
              fn = (__webpack_require__(12).Object || {})[KEY] || Object[KEY],
              exp = {};
          exp[KEY] = exec(fn);
          $def($def.S + $def.F * __webpack_require__(18)(function() {
            fn(1);
          }), 'Object', exp);
        };
      }, function(module, exports, __webpack_require__) {
        module.exports = {
          "default": __webpack_require__(85),
          __esModule: true
        };
      }, function(module, exports, __webpack_require__) {
        __webpack_require__(67);
        __webpack_require__(4);
        __webpack_require__(42);
        __webpack_require__(86);
        __webpack_require__(89);
        module.exports = __webpack_require__(12).Set;
      }, function(module, exports, __webpack_require__) {
        'use strict';
        var strong = __webpack_require__(87);
        __webpack_require__(88)('Set', function(get) {
          return function Set() {
            return get(this, arguments[0]);
          };
        }, {add: function add(value) {
            return strong.def(this, value = value === 0 ? 0 : value, value);
          }}, strong);
      }, function(module, exports, __webpack_require__) {
        'use strict';
        var $ = __webpack_require__(15),
            hide = __webpack_require__(14),
            ctx = __webpack_require__(27),
            species = __webpack_require__(73),
            strictNew = __webpack_require__(69),
            defined = __webpack_require__(7),
            forOf = __webpack_require__(70),
            step = __webpack_require__(45),
            ID = __webpack_require__(22)('id'),
            $has = __webpack_require__(19),
            isObject = __webpack_require__(32),
            isExtensible = Object.isExtensible || isObject,
            SUPPORT_DESC = __webpack_require__(17),
            SIZE = SUPPORT_DESC ? '_s' : 'size',
            id = 0;
        var fastKey = function(it, create) {
          if (!isObject(it))
            return typeof it == 'symbol' ? it : (typeof it == 'string' ? 'S' : 'P') + it;
          if (!$has(it, ID)) {
            if (!isExtensible(it))
              return 'F';
            if (!create)
              return 'E';
            hide(it, ID, ++id);
          }
          return 'O' + it[ID];
        };
        var getEntry = function(that, key) {
          var index = fastKey(key),
              entry;
          if (index !== 'F')
            return that._i[index];
          for (entry = that._f; entry; entry = entry.n) {
            if (entry.k == key)
              return entry;
          }
        };
        module.exports = {
          getConstructor: function(wrapper, NAME, IS_MAP, ADDER) {
            var C = wrapper(function(that, iterable) {
              strictNew(that, C, NAME);
              that._i = $.create(null);
              that._f = undefined;
              that._l = undefined;
              that[SIZE] = 0;
              if (iterable != undefined)
                forOf(iterable, IS_MAP, that[ADDER], that);
            });
            __webpack_require__(79)(C.prototype, {
              clear: function clear() {
                for (var that = this,
                    data = that._i,
                    entry = that._f; entry; entry = entry.n) {
                  entry.r = true;
                  if (entry.p)
                    entry.p = entry.p.n = undefined;
                  delete data[entry.i];
                }
                that._f = that._l = undefined;
                that[SIZE] = 0;
              },
              'delete': function(key) {
                var that = this,
                    entry = getEntry(that, key);
                if (entry) {
                  var next = entry.n,
                      prev = entry.p;
                  delete that._i[entry.i];
                  entry.r = true;
                  if (prev)
                    prev.n = next;
                  if (next)
                    next.p = prev;
                  if (that._f == entry)
                    that._f = next;
                  if (that._l == entry)
                    that._l = prev;
                  that[SIZE]--;
                }
                return !!entry;
              },
              forEach: function forEach(callbackfn) {
                var f = ctx(callbackfn, arguments[1], 3),
                    entry;
                while (entry = entry ? entry.n : this._f) {
                  f(entry.v, entry.k, this);
                  while (entry && entry.r)
                    entry = entry.p;
                }
              },
              has: function has(key) {
                return !!getEntry(this, key);
              }
            });
            if (SUPPORT_DESC)
              $.setDesc(C.prototype, 'size', {get: function() {
                  return defined(this[SIZE]);
                }});
            return C;
          },
          def: function(that, key, value) {
            var entry = getEntry(that, key),
                prev,
                index;
            if (entry) {
              entry.v = value;
            } else {
              that._l = entry = {
                i: index = fastKey(key, true),
                k: key,
                v: value,
                p: prev = that._l,
                n: undefined,
                r: false
              };
              if (!that._f)
                that._f = entry;
              if (prev)
                prev.n = entry;
              that[SIZE]++;
              if (index !== 'F')
                that._i[index] = entry;
            }
            return that;
          },
          getEntry: getEntry,
          setStrong: function(C, NAME, IS_MAP) {
            __webpack_require__(8)(C, NAME, function(iterated, kind) {
              this._t = iterated;
              this._k = kind;
              this._l = undefined;
            }, function() {
              var that = this,
                  kind = that._k,
                  entry = that._l;
              while (entry && entry.r)
                entry = entry.p;
              if (!that._t || !(that._l = entry = entry ? entry.n : that._t._f)) {
                that._t = undefined;
                return step(1);
              }
              if (kind == 'keys')
                return step(0, entry.k);
              if (kind == 'values')
                return step(0, entry.v);
              return step(0, [entry.k, entry.v]);
            }, IS_MAP ? 'entries' : 'values', !IS_MAP, true);
            species(C);
            species(__webpack_require__(12)[NAME]);
          }
        };
      }, function(module, exports, __webpack_require__) {
        'use strict';
        var $ = __webpack_require__(15),
            $def = __webpack_require__(10),
            hide = __webpack_require__(14),
            forOf = __webpack_require__(70),
            strictNew = __webpack_require__(69);
        module.exports = function(NAME, wrapper, methods, common, IS_MAP, IS_WEAK) {
          var Base = __webpack_require__(11)[NAME],
              C = Base,
              ADDER = IS_MAP ? 'set' : 'add',
              proto = C && C.prototype,
              O = {};
          if (!__webpack_require__(17) || typeof C != 'function' || !(IS_WEAK || proto.forEach && !__webpack_require__(18)(function() {
            new C().entries().next();
          }))) {
            C = common.getConstructor(wrapper, NAME, IS_MAP, ADDER);
            __webpack_require__(79)(C.prototype, methods);
          } else {
            C = wrapper(function(target, iterable) {
              strictNew(target, C, NAME);
              target._c = new Base;
              if (iterable != undefined)
                forOf(iterable, IS_MAP, target[ADDER], target);
            });
            $.each.call('add,clear,delete,forEach,get,has,set,keys,values,entries'.split(','), function(KEY) {
              var chain = KEY == 'add' || KEY == 'set';
              if (KEY in proto && !(IS_WEAK && KEY == 'clear'))
                hide(C.prototype, KEY, function(a, b) {
                  var result = this._c[KEY](a === 0 ? 0 : a, b);
                  return chain ? this : result;
                });
            });
            if ('size' in proto)
              $.setDesc(C.prototype, 'size', {get: function() {
                  return this._c.size;
                }});
          }
          __webpack_require__(25)(C, NAME);
          O[NAME] = C;
          $def($def.G + $def.W + $def.F, O);
          if (!IS_WEAK)
            common.setStrong(C, NAME, IS_MAP);
          return C;
        };
      }, function(module, exports, __webpack_require__) {
        var $def = __webpack_require__(10);
        $def($def.P, 'Set', {toJSON: __webpack_require__(90)('Set')});
      }, function(module, exports, __webpack_require__) {
        var forOf = __webpack_require__(70),
            classof = __webpack_require__(36);
        module.exports = function(NAME) {
          return function toJSON() {
            if (classof(this) != NAME)
              throw TypeError(NAME + "#toJSON isn't generic");
            var arr = [];
            forOf(this, false, arr.push, arr);
            return arr;
          };
        };
      }]);
    });
    ;
  })(require("49"));
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("34", ["42", "43", "4a"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  require("42");
  require("43");
  module.exports = require("4a")('iterator');
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("35", ["41", "42", "43", "4b", "4c", "3d"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  require("41");
  require("42");
  require("43");
  require("4b");
  require("4c");
  module.exports = require("3d").Set;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("36", ["42", "4d", "3d"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  require("42");
  require("4d");
  module.exports = require("3d").Array.from;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("37", ["4e"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var $ = require("4e");
  module.exports = function defineProperty(it, key, desc) {
    return $.setDesc(it, key, desc);
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("38", ["4e"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var $ = require("4e");
  module.exports = function create(P, D) {
    return $.create(P, D);
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("39", ["4f", "3d"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  require("4f");
  module.exports = require("3d").Object.setPrototypeOf;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("3a", ["4e", "50"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var $ = require("4e");
  require("50");
  module.exports = function getOwnPropertyDescriptor(it, key) {
    return $.getDesc(it, key);
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("3c", ["51", "52"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var toObject = require("51");
  require("52")('keys', function($keys) {
    return function keys(it) {
      return $keys(toObject(it));
    };
  });
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("3b", ["43", "42", "53"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  require("43");
  require("42");
  module.exports = require("53");
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("3d", [], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var core = module.exports = {};
  if (typeof __e == 'number')
    __e = core;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("3e", ["54"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  "use strict";
  var createThunk = require("54");
  function Procedure() {
    this.argTypes = [];
    this.shimArgs = [];
    this.arrayArgs = [];
    this.arrayBlockIndices = [];
    this.scalarArgs = [];
    this.offsetArgs = [];
    this.offsetArgIndex = [];
    this.indexArgs = [];
    this.shapeArgs = [];
    this.funcName = "";
    this.pre = null;
    this.body = null;
    this.post = null;
    this.debug = false;
  }
  function compileCwise(user_args) {
    var proc = new Procedure();
    proc.pre = user_args.pre;
    proc.body = user_args.body;
    proc.post = user_args.post;
    var proc_args = user_args.args.slice(0);
    proc.argTypes = proc_args;
    for (var i = 0; i < proc_args.length; ++i) {
      var arg_type = proc_args[i];
      if (arg_type === "array" || (typeof arg_type === "object" && arg_type.blockIndices)) {
        proc.argTypes[i] = "array";
        proc.arrayArgs.push(i);
        proc.arrayBlockIndices.push(arg_type.blockIndices ? arg_type.blockIndices : 0);
        proc.shimArgs.push("array" + i);
        if (i < proc.pre.args.length && proc.pre.args[i].count > 0) {
          throw new Error("cwise: pre() block may not reference array args");
        }
        if (i < proc.post.args.length && proc.post.args[i].count > 0) {
          throw new Error("cwise: post() block may not reference array args");
        }
      } else if (arg_type === "scalar") {
        proc.scalarArgs.push(i);
        proc.shimArgs.push("scalar" + i);
      } else if (arg_type === "index") {
        proc.indexArgs.push(i);
        if (i < proc.pre.args.length && proc.pre.args[i].count > 0) {
          throw new Error("cwise: pre() block may not reference array index");
        }
        if (i < proc.body.args.length && proc.body.args[i].lvalue) {
          throw new Error("cwise: body() block may not write to array index");
        }
        if (i < proc.post.args.length && proc.post.args[i].count > 0) {
          throw new Error("cwise: post() block may not reference array index");
        }
      } else if (arg_type === "shape") {
        proc.shapeArgs.push(i);
        if (i < proc.pre.args.length && proc.pre.args[i].lvalue) {
          throw new Error("cwise: pre() block may not write to array shape");
        }
        if (i < proc.body.args.length && proc.body.args[i].lvalue) {
          throw new Error("cwise: body() block may not write to array shape");
        }
        if (i < proc.post.args.length && proc.post.args[i].lvalue) {
          throw new Error("cwise: post() block may not write to array shape");
        }
      } else if (typeof arg_type === "object" && arg_type.offset) {
        proc.argTypes[i] = "offset";
        proc.offsetArgs.push({
          array: arg_type.array,
          offset: arg_type.offset
        });
        proc.offsetArgIndex.push(i);
      } else {
        throw new Error("cwise: Unknown argument type " + proc_args[i]);
      }
    }
    if (proc.arrayArgs.length <= 0) {
      throw new Error("cwise: No array arguments specified");
    }
    if (proc.pre.args.length > proc_args.length) {
      throw new Error("cwise: Too many arguments in pre() block");
    }
    if (proc.body.args.length > proc_args.length) {
      throw new Error("cwise: Too many arguments in body() block");
    }
    if (proc.post.args.length > proc_args.length) {
      throw new Error("cwise: Too many arguments in post() block");
    }
    proc.debug = !!user_args.printCode || !!user_args.debug;
    proc.funcName = user_args.funcName || "cwise";
    proc.blockSize = user_args.blockSize || 64;
    return createThunk(proc);
  }
  module.exports = compileCwise;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("3f", ["55"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  module.exports = require("55");
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("41", [], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  "format cjs";
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("40", ["56"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  module.exports = require("56");
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("43", ["57", "58"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  require("57");
  var Iterators = require("58");
  Iterators.NodeList = Iterators.HTMLCollection = Iterators.Array;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("44", ["4e", "59", "5a", "5b", "5c", "5d", "5e", "5f", "60", "61", "62", "63", "64", "65", "4a", "66", "67", "68", "69", "6a", "3d", "6b", "49"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  (function(process) {
    'use strict';
    var $ = require("4e"),
        LIBRARY = require("59"),
        global = require("5a"),
        ctx = require("5b"),
        classof = require("5c"),
        $def = require("5d"),
        isObject = require("5e"),
        anObject = require("5f"),
        aFunction = require("60"),
        strictNew = require("61"),
        forOf = require("62"),
        setProto = require("63").set,
        same = require("64"),
        species = require("65"),
        SPECIES = require("4a")('species'),
        RECORD = require("66")('record'),
        asap = require("67"),
        PROMISE = 'Promise',
        process = global.process,
        isNode = classof(process) == 'process',
        P = global[PROMISE],
        Wrapper;
    var testResolve = function(sub) {
      var test = new P(function() {});
      if (sub)
        test.constructor = Object;
      return P.resolve(test) === test;
    };
    var useNative = function() {
      var works = false;
      function P2(x) {
        var self = new P(x);
        setProto(self, P2.prototype);
        return self;
      }
      try {
        works = P && P.resolve && testResolve();
        setProto(P2, P);
        P2.prototype = $.create(P.prototype, {constructor: {value: P2}});
        if (!(P2.resolve(5).then(function() {}) instanceof P2)) {
          works = false;
        }
        if (works && require("68")) {
          var thenableThenGotten = false;
          P.resolve($.setDesc({}, 'then', {get: function() {
              thenableThenGotten = true;
            }}));
          works = thenableThenGotten;
        }
      } catch (e) {
        works = false;
      }
      return works;
    }();
    var isPromise = function(it) {
      return isObject(it) && (useNative ? classof(it) == 'Promise' : RECORD in it);
    };
    var sameConstructor = function(a, b) {
      if (LIBRARY && a === P && b === Wrapper)
        return true;
      return same(a, b);
    };
    var getConstructor = function(C) {
      var S = anObject(C)[SPECIES];
      return S != undefined ? S : C;
    };
    var isThenable = function(it) {
      var then;
      return isObject(it) && typeof(then = it.then) == 'function' ? then : false;
    };
    var notify = function(record, isReject) {
      if (record.n)
        return;
      record.n = true;
      var chain = record.c;
      asap(function() {
        var value = record.v,
            ok = record.s == 1,
            i = 0;
        var run = function(react) {
          var cb = ok ? react.ok : react.fail,
              ret,
              then;
          try {
            if (cb) {
              if (!ok)
                record.h = true;
              ret = cb === true ? value : cb(value);
              if (ret === react.P) {
                react.rej(TypeError('Promise-chain cycle'));
              } else if (then = isThenable(ret)) {
                then.call(ret, react.res, react.rej);
              } else
                react.res(ret);
            } else
              react.rej(value);
          } catch (err) {
            react.rej(err);
          }
        };
        while (chain.length > i)
          run(chain[i++]);
        chain.length = 0;
        record.n = false;
        if (isReject)
          setTimeout(function() {
            if (isUnhandled(record.p)) {
              if (isNode) {
                process.emit('unhandledRejection', value, record.p);
              } else if (global.console && console.error) {
                console.error('Unhandled promise rejection', value);
              }
            }
            record.a = undefined;
          }, 1);
      });
    };
    var isUnhandled = function(promise) {
      var record = promise[RECORD],
          chain = record.a || record.c,
          i = 0,
          react;
      if (record.h)
        return false;
      while (chain.length > i) {
        react = chain[i++];
        if (react.fail || !isUnhandled(react.P))
          return false;
      }
      return true;
    };
    var $reject = function(value) {
      var record = this;
      if (record.d)
        return;
      record.d = true;
      record = record.r || record;
      record.v = value;
      record.s = 2;
      record.a = record.c.slice();
      notify(record, true);
    };
    var $resolve = function(value) {
      var record = this,
          then;
      if (record.d)
        return;
      record.d = true;
      record = record.r || record;
      try {
        if (then = isThenable(value)) {
          asap(function() {
            var wrapper = {
              r: record,
              d: false
            };
            try {
              then.call(value, ctx($resolve, wrapper, 1), ctx($reject, wrapper, 1));
            } catch (e) {
              $reject.call(wrapper, e);
            }
          });
        } else {
          record.v = value;
          record.s = 1;
          notify(record, false);
        }
      } catch (e) {
        $reject.call({
          r: record,
          d: false
        }, e);
      }
    };
    if (!useNative) {
      P = function Promise(executor) {
        aFunction(executor);
        var record = {
          p: strictNew(this, P, PROMISE),
          c: [],
          a: undefined,
          s: 0,
          d: false,
          v: undefined,
          h: false,
          n: false
        };
        this[RECORD] = record;
        try {
          executor(ctx($resolve, record, 1), ctx($reject, record, 1));
        } catch (err) {
          $reject.call(record, err);
        }
      };
      require("69")(P.prototype, {
        then: function then(onFulfilled, onRejected) {
          var S = anObject(anObject(this).constructor)[SPECIES];
          var react = {
            ok: typeof onFulfilled == 'function' ? onFulfilled : true,
            fail: typeof onRejected == 'function' ? onRejected : false
          };
          var promise = react.P = new (S != undefined ? S : P)(function(res, rej) {
            react.res = aFunction(res);
            react.rej = aFunction(rej);
          });
          var record = this[RECORD];
          record.c.push(react);
          if (record.a)
            record.a.push(react);
          if (record.s)
            notify(record, false);
          return promise;
        },
        'catch': function(onRejected) {
          return this.then(undefined, onRejected);
        }
      });
    }
    $def($def.G + $def.W + $def.F * !useNative, {Promise: P});
    require("6a")(P, PROMISE);
    species(P);
    species(Wrapper = require("3d")[PROMISE]);
    $def($def.S + $def.F * !useNative, PROMISE, {reject: function reject(r) {
        return new this(function(res, rej) {
          rej(r);
        });
      }});
    $def($def.S + $def.F * (!useNative || testResolve(true)), PROMISE, {resolve: function resolve(x) {
        return isPromise(x) && sameConstructor(x.constructor, this) ? x : new this(function(res) {
          res(x);
        });
      }});
    $def($def.S + $def.F * !(useNative && require("6b")(function(iter) {
      P.all(iter)['catch'](function() {});
    })), PROMISE, {
      all: function all(iterable) {
        var C = getConstructor(this),
            values = [];
        return new C(function(res, rej) {
          forOf(iterable, false, values.push, values);
          var remaining = values.length,
              results = Array(remaining);
          if (remaining)
            $.each.call(values, function(promise, index) {
              C.resolve(promise).then(function(value) {
                results[index] = value;
                --remaining || res(results);
              }, rej);
            });
          else
            res(results);
        });
      },
      race: function race(iterable) {
        var C = getConstructor(this);
        return new C(function(res, rej) {
          forOf(iterable, false, function(promise) {
            C.resolve(promise).then(res, rej);
          });
        });
      }
    });
  })(require("49"));
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("42", ["6c", "6d"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var $at = require("6c")(true);
  require("6d")(String, 'String', function(iterated) {
    this._t = String(iterated);
    this._i = 0;
  }, function() {
    var O = this._t,
        index = this._i,
        point;
    if (index >= O.length)
      return {
        value: undefined,
        done: true
      };
    point = $at(O, index);
    this._i += point.length;
    return {
      value: point,
      done: false
    };
  });
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("45", ["6e", "6f"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var strong = require("6e");
  require("6f")('Map', function(get) {
    return function Map() {
      return get(this, arguments[0]);
    };
  }, {
    get: function get(key) {
      var entry = strong.getEntry(this, key);
      return entry && entry.v;
    },
    set: function set(key, value) {
      return strong.def(this, key === 0 ? 0 : key, value);
    }
  }, strong, true);
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("46", ["5d", "70"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var $def = require("5d");
  $def($def.P, 'Map', {toJSON: require("70")('Map')});
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("47", ["5f", "71", "3d"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var anObject = require("5f"),
      get = require("71");
  module.exports = require("3d").getIterator = function(it) {
    var iterFn = get(it);
    if (typeof iterFn != 'function')
      throw TypeError(it + ' is not iterable!');
    return anObject(iterFn.call(it));
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("48", ["5d"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var $def = require("5d");
  $def($def.S, 'Math', {trunc: function trunc(it) {
      return (it > 0 ? Math.floor : Math.ceil)(it);
    }});
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("49", ["72"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  module.exports = require("72");
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("4a", ["73", "5a", "66"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var store = require("73")('wks'),
      Symbol = require("5a").Symbol;
  module.exports = function(name) {
    return store[name] || (store[name] = Symbol && Symbol[name] || (Symbol || require("66"))('Symbol.' + name));
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("4b", ["6e", "6f"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var strong = require("6e");
  require("6f")('Set', function(get) {
    return function Set() {
      return get(this, arguments[0]);
    };
  }, {add: function add(value) {
      return strong.def(this, value = value === 0 ? 0 : value, value);
    }}, strong);
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("4c", ["5d", "70"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var $def = require("5d");
  $def($def.P, 'Set', {toJSON: require("70")('Set')});
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("4d", ["5b", "5d", "51", "74", "75", "76", "71", "6b"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var ctx = require("5b"),
      $def = require("5d"),
      toObject = require("51"),
      call = require("74"),
      isArrayIter = require("75"),
      toLength = require("76"),
      getIterFn = require("71");
  $def($def.S + $def.F * !require("6b")(function(iter) {
    Array.from(iter);
  }), 'Array', {from: function from(arrayLike) {
      var O = toObject(arrayLike),
          C = typeof this == 'function' ? this : Array,
          mapfn = arguments[1],
          mapping = mapfn !== undefined,
          index = 0,
          iterFn = getIterFn(O),
          length,
          result,
          step,
          iterator;
      if (mapping)
        mapfn = ctx(mapfn, arguments[2], 2);
      if (iterFn != undefined && !(C == Array && isArrayIter(iterFn))) {
        for (iterator = iterFn.call(O), result = new C; !(step = iterator.next()).done; index++) {
          result[index] = mapping ? call(iterator, mapfn, [step.value, index], true) : step.value;
        }
      } else {
        for (result = new C(length = toLength(O.length)); length > index; index++) {
          result[index] = mapping ? mapfn(O[index], index) : O[index];
        }
      }
      result.length = index;
      return result;
    }});
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("4e", [], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var $Object = Object;
  module.exports = {
    create: $Object.create,
    getProto: $Object.getPrototypeOf,
    isEnum: {}.propertyIsEnumerable,
    getDesc: $Object.getOwnPropertyDescriptor,
    setDesc: $Object.defineProperty,
    setDescs: $Object.defineProperties,
    getKeys: $Object.keys,
    getNames: $Object.getOwnPropertyNames,
    getSymbols: $Object.getOwnPropertySymbols,
    each: [].forEach
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("4f", ["5d", "63"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var $def = require("5d");
  $def($def.S, 'Object', {setPrototypeOf: require("63").set});
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("50", ["77", "52"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var toIObject = require("77");
  require("52")('getOwnPropertyDescriptor', function($getOwnPropertyDescriptor) {
    return function getOwnPropertyDescriptor(it, key) {
      return $getOwnPropertyDescriptor(toIObject(it), key);
    };
  });
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("52", ["5d", "3d", "78"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  module.exports = function(KEY, exec) {
    var $def = require("5d"),
        fn = (require("3d").Object || {})[KEY] || Object[KEY],
        exp = {};
    exp[KEY] = exec(fn);
    $def($def.S + $def.F * require("78")(function() {
      fn(1);
    }), 'Object', exp);
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("53", ["5c", "4a", "58", "3d"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var classof = require("5c"),
      ITERATOR = require("4a")('iterator'),
      Iterators = require("58");
  module.exports = require("3d").isIterable = function(it) {
    var O = Object(it);
    return ITERATOR in O || '@@iterator' in O || Iterators.hasOwnProperty(classof(O));
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("51", ["79"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var defined = require("79");
  module.exports = function(it) {
    return Object(defined(it));
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("54", ["7a"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  "use strict";
  var compile = require("7a");
  function createThunk(proc) {
    var code = ["'use strict'", "var CACHED={}"];
    var vars = [];
    var thunkName = proc.funcName + "_cwise_thunk";
    code.push(["return function ", thunkName, "(", proc.shimArgs.join(","), "){"].join(""));
    var typesig = [];
    var string_typesig = [];
    var proc_args = [["array", proc.arrayArgs[0], ".shape.slice(", Math.max(0, proc.arrayBlockIndices[0]), proc.arrayBlockIndices[0] < 0 ? ("," + proc.arrayBlockIndices[0] + ")") : ")"].join("")];
    var shapeLengthConditions = [],
        shapeConditions = [];
    for (var i = 0; i < proc.arrayArgs.length; ++i) {
      var j = proc.arrayArgs[i];
      vars.push(["t", j, "=array", j, ".dtype,", "r", j, "=array", j, ".order"].join(""));
      typesig.push("t" + j);
      typesig.push("r" + j);
      string_typesig.push("t" + j);
      string_typesig.push("r" + j + ".join()");
      proc_args.push("array" + j + ".data");
      proc_args.push("array" + j + ".stride");
      proc_args.push("array" + j + ".offset|0");
      if (i > 0) {
        shapeLengthConditions.push("array" + proc.arrayArgs[0] + ".shape.length===array" + j + ".shape.length+" + (Math.abs(proc.arrayBlockIndices[0]) - Math.abs(proc.arrayBlockIndices[i])));
        shapeConditions.push("array" + proc.arrayArgs[0] + ".shape[shapeIndex+" + Math.max(0, proc.arrayBlockIndices[0]) + "]===array" + j + ".shape[shapeIndex+" + Math.max(0, proc.arrayBlockIndices[i]) + "]");
      }
    }
    if (proc.arrayArgs.length > 1) {
      code.push("if (!(" + shapeLengthConditions.join(" && ") + ")) throw new Error('cwise: Arrays do not all have the same dimensionality!')");
      code.push("for(var shapeIndex=array" + proc.arrayArgs[0] + ".shape.length-" + Math.abs(proc.arrayBlockIndices[0]) + "; shapeIndex-->0;) {");
      code.push("if (!(" + shapeConditions.join(" && ") + ")) throw new Error('cwise: Arrays do not all have the same shape!')");
      code.push("}");
    }
    for (var i = 0; i < proc.scalarArgs.length; ++i) {
      proc_args.push("scalar" + proc.scalarArgs[i]);
    }
    vars.push(["type=[", string_typesig.join(","), "].join()"].join(""));
    vars.push("proc=CACHED[type]");
    code.push("var " + vars.join(","));
    code.push(["if(!proc){", "CACHED[type]=proc=compile([", typesig.join(","), "])}", "return proc(", proc_args.join(","), ")}"].join(""));
    if (proc.debug) {
      console.log("-----Generated thunk:\n" + code.join("\n") + "\n----------");
    }
    var thunk = new Function("compile", code.join("\n"));
    return thunk(compile.bind(undefined, proc));
  }
  module.exports = createThunk;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("55", [], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  "use strict";
  function iota(n) {
    var result = new Array(n);
    for (var i = 0; i < n; ++i) {
      result[i] = i;
    }
    return result;
  }
  module.exports = iota;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("56", ["7b"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  (function(Buffer) {
    module.exports = function(obj) {
      return !!(obj != null && obj.constructor && typeof obj.constructor.isBuffer === 'function' && obj.constructor.isBuffer(obj));
    };
  })(require("7b").Buffer);
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("57", ["7c", "7d", "58", "77", "6d"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var setUnscope = require("7c"),
      step = require("7d"),
      Iterators = require("58"),
      toIObject = require("77");
  require("6d")(Array, 'Array', function(iterated, kind) {
    this._t = toIObject(iterated);
    this._i = 0;
    this._k = kind;
  }, function() {
    var O = this._t,
        kind = this._k,
        index = this._i++;
    if (!O || index >= O.length) {
      this._t = undefined;
      return step(1);
    }
    if (kind == 'keys')
      return step(0, index);
    if (kind == 'values')
      return step(0, O[index]);
    return step(0, [index, O[index]]);
  }, 'values');
  Iterators.Arguments = Iterators.Array;
  setUnscope('keys');
  setUnscope('values');
  setUnscope('entries');
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("58", [], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  module.exports = {};
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("5a", [], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var UNDEFINED = 'undefined';
  var global = module.exports = typeof window != UNDEFINED && window.Math == Math ? window : typeof self != UNDEFINED && self.Math == Math ? self : Function('return this')();
  if (typeof __g == 'number')
    __g = global;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("5b", ["60"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var aFunction = require("60");
  module.exports = function(fn, that, length) {
    aFunction(fn);
    if (that === undefined)
      return fn;
    switch (length) {
      case 1:
        return function(a) {
          return fn.call(that, a);
        };
      case 2:
        return function(a, b) {
          return fn.call(that, a, b);
        };
      case 3:
        return function(a, b, c) {
          return fn.call(that, a, b, c);
        };
    }
    return function() {
      return fn.apply(that, arguments);
    };
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("59", [], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  module.exports = true;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("5c", ["7e", "4a"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var cof = require("7e"),
      TAG = require("4a")('toStringTag'),
      ARG = cof(function() {
        return arguments;
      }()) == 'Arguments';
  module.exports = function(it) {
    var O,
        T,
        B;
    return it === undefined ? 'Undefined' : it === null ? 'Null' : typeof(T = (O = Object(it))[TAG]) == 'string' ? T : ARG ? cof(O) : (B = cof(O)) == 'Object' && typeof O.callee == 'function' ? 'Arguments' : B;
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("5d", ["5a", "3d"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var global = require("5a"),
      core = require("3d"),
      PROTOTYPE = 'prototype';
  var ctx = function(fn, that) {
    return function() {
      return fn.apply(that, arguments);
    };
  };
  var $def = function(type, name, source) {
    var key,
        own,
        out,
        exp,
        isGlobal = type & $def.G,
        isProto = type & $def.P,
        target = isGlobal ? global : type & $def.S ? global[name] : (global[name] || {})[PROTOTYPE],
        exports = isGlobal ? core : core[name] || (core[name] = {});
    if (isGlobal)
      source = name;
    for (key in source) {
      own = !(type & $def.F) && target && key in target;
      if (own && key in exports)
        continue;
      out = own ? target[key] : source[key];
      if (isGlobal && typeof target[key] != 'function')
        exp = source[key];
      else if (type & $def.B && own)
        exp = ctx(out, global);
      else if (type & $def.W && target[key] == out)
        !function(C) {
          exp = function(param) {
            return this instanceof C ? new C(param) : C(param);
          };
          exp[PROTOTYPE] = C[PROTOTYPE];
        }(out);
      else
        exp = isProto && typeof out == 'function' ? ctx(Function.call, out) : out;
      exports[key] = exp;
      if (isProto)
        (exports[PROTOTYPE] || (exports[PROTOTYPE] = {}))[key] = out;
    }
  };
  $def.F = 1;
  $def.G = 2;
  $def.S = 4;
  $def.P = 8;
  $def.B = 16;
  $def.W = 32;
  module.exports = $def;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("5f", ["5e"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var isObject = require("5e");
  module.exports = function(it) {
    if (!isObject(it))
      throw TypeError(it + ' is not an object!');
    return it;
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("5e", [], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  module.exports = function(it) {
    return it !== null && (typeof it == 'object' || typeof it == 'function');
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("60", [], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  module.exports = function(it) {
    if (typeof it != 'function')
      throw TypeError(it + ' is not a function!');
    return it;
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("61", [], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  module.exports = function(it, Constructor, name) {
    if (!(it instanceof Constructor))
      throw TypeError(name + ": use the 'new' operator!");
    return it;
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("63", ["4e", "5e", "5f", "5b"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var getDesc = require("4e").getDesc,
      isObject = require("5e"),
      anObject = require("5f");
  var check = function(O, proto) {
    anObject(O);
    if (!isObject(proto) && proto !== null)
      throw TypeError(proto + ": can't set as prototype!");
  };
  module.exports = {
    set: Object.setPrototypeOf || ('__proto__' in {} ? function(buggy, set) {
      try {
        set = require("5b")(Function.call, getDesc(Object.prototype, '__proto__').set, 2);
        set({}, []);
      } catch (e) {
        buggy = true;
      }
      return function setPrototypeOf(O, proto) {
        check(O, proto);
        if (buggy)
          O.__proto__ = proto;
        else
          set(O, proto);
        return O;
      };
    }() : undefined),
    check: check
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("62", ["5b", "74", "75", "5f", "76", "71"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var ctx = require("5b"),
      call = require("74"),
      isArrayIter = require("75"),
      anObject = require("5f"),
      toLength = require("76"),
      getIterFn = require("71");
  module.exports = function(iterable, entries, fn, that) {
    var iterFn = getIterFn(iterable),
        f = ctx(fn, that, entries ? 2 : 1),
        index = 0,
        length,
        step,
        iterator;
    if (typeof iterFn != 'function')
      throw TypeError(iterable + ' is not iterable!');
    if (isArrayIter(iterFn))
      for (length = toLength(iterable.length); length > index; index++) {
        entries ? f(anObject(step = iterable[index])[0], step[1]) : f(iterable[index]);
      }
    else
      for (iterator = iterFn.call(iterable); !(step = iterator.next()).done; ) {
        call(iterator, f, step.value, entries);
      }
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("64", [], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  module.exports = Object.is || function is(x, y) {
    return x === y ? x !== 0 || 1 / x === 1 / y : x != x && y != y;
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("65", ["4e", "4a", "68"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var $ = require("4e"),
      SPECIES = require("4a")('species');
  module.exports = function(C) {
    if (require("68") && !(SPECIES in C))
      $.setDesc(C, SPECIES, {
        configurable: true,
        get: function() {
          return this;
        }
      });
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("67", ["5a", "7f", "7e", "49"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  (function(process) {
    var global = require("5a"),
        macrotask = require("7f").set,
        Observer = global.MutationObserver || global.WebKitMutationObserver,
        process = global.process,
        isNode = require("7e")(process) == 'process',
        head,
        last,
        notify;
    var flush = function() {
      var parent,
          domain;
      if (isNode && (parent = process.domain)) {
        process.domain = null;
        parent.exit();
      }
      while (head) {
        domain = head.domain;
        if (domain)
          domain.enter();
        head.fn.call();
        if (domain)
          domain.exit();
        head = head.next;
      }
      last = undefined;
      if (parent)
        parent.enter();
    };
    if (isNode) {
      notify = function() {
        process.nextTick(flush);
      };
    } else if (Observer) {
      var toggle = 1,
          node = document.createTextNode('');
      new Observer(flush).observe(node, {characterData: true});
      notify = function() {
        node.data = toggle = -toggle;
      };
    } else {
      notify = function() {
        macrotask.call(global, flush);
      };
    }
    module.exports = function asap(fn) {
      var task = {
        fn: fn,
        next: undefined,
        domain: isNode && process.domain
      };
      if (last)
        last.next = task;
      if (!head) {
        head = task;
        notify();
      }
      last = task;
    };
  })(require("49"));
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("66", [], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var id = 0,
      px = Math.random();
  module.exports = function(key) {
    return 'Symbol('.concat(key === undefined ? '' : key, ')_', (++id + px).toString(36));
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("68", ["78"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  module.exports = !require("78")(function() {
    return Object.defineProperty({}, 'a', {get: function() {
        return 7;
      }}).a != 7;
  });
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("69", ["80"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var $redef = require("80");
  module.exports = function(target, src) {
    for (var key in src)
      $redef(target, key, src[key]);
    return target;
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("6a", ["81", "82", "4a"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var has = require("81"),
      hide = require("82"),
      TAG = require("4a")('toStringTag');
  module.exports = function(it, tag, stat) {
    if (it && !has(it = stat ? it : it.prototype, TAG))
      hide(it, TAG, tag);
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("6b", ["4a"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var SYMBOL_ITERATOR = require("4a")('iterator'),
      SAFE_CLOSING = false;
  try {
    var riter = [7][SYMBOL_ITERATOR]();
    riter['return'] = function() {
      SAFE_CLOSING = true;
    };
    Array.from(riter, function() {
      throw 2;
    });
  } catch (e) {}
  module.exports = function(exec) {
    if (!SAFE_CLOSING)
      return false;
    var safe = false;
    try {
      var arr = [7],
          iter = arr[SYMBOL_ITERATOR]();
      iter.next = function() {
        safe = true;
      };
      arr[SYMBOL_ITERATOR] = function() {
        return iter;
      };
      exec(arr);
    } catch (e) {}
    return safe;
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("6d", ["59", "5d", "80", "82", "81", "4a", "58", "83", "4e", "6a"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var LIBRARY = require("59"),
      $def = require("5d"),
      $redef = require("80"),
      hide = require("82"),
      has = require("81"),
      SYMBOL_ITERATOR = require("4a")('iterator'),
      Iterators = require("58"),
      BUGGY = !([].keys && 'next' in [].keys()),
      FF_ITERATOR = '@@iterator',
      KEYS = 'keys',
      VALUES = 'values';
  var returnThis = function() {
    return this;
  };
  module.exports = function(Base, NAME, Constructor, next, DEFAULT, IS_SET, FORCE) {
    require("83")(Constructor, NAME, next);
    var createMethod = function(kind) {
      switch (kind) {
        case KEYS:
          return function keys() {
            return new Constructor(this, kind);
          };
        case VALUES:
          return function values() {
            return new Constructor(this, kind);
          };
      }
      return function entries() {
        return new Constructor(this, kind);
      };
    };
    var TAG = NAME + ' Iterator',
        proto = Base.prototype,
        _native = proto[SYMBOL_ITERATOR] || proto[FF_ITERATOR] || DEFAULT && proto[DEFAULT],
        _default = _native || createMethod(DEFAULT),
        methods,
        key;
    if (_native) {
      var IteratorPrototype = require("4e").getProto(_default.call(new Base));
      require("6a")(IteratorPrototype, TAG, true);
      if (!LIBRARY && has(proto, FF_ITERATOR))
        hide(IteratorPrototype, SYMBOL_ITERATOR, returnThis);
    }
    if (!LIBRARY || FORCE)
      hide(proto, SYMBOL_ITERATOR, _default);
    Iterators[NAME] = _default;
    Iterators[TAG] = returnThis;
    if (DEFAULT) {
      methods = {
        keys: IS_SET ? _default : createMethod(KEYS),
        values: DEFAULT == VALUES ? _default : createMethod(VALUES),
        entries: DEFAULT != VALUES ? _default : createMethod('entries')
      };
      if (FORCE)
        for (key in methods) {
          if (!(key in proto))
            $redef(proto, key, methods[key]);
        }
      else
        $def($def.P + $def.F * BUGGY, NAME, methods);
    }
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("6c", ["84", "79"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var toInteger = require("84"),
      defined = require("79");
  module.exports = function(TO_STRING) {
    return function(that, pos) {
      var s = String(defined(that)),
          i = toInteger(pos),
          l = s.length,
          a,
          b;
      if (i < 0 || i >= l)
        return TO_STRING ? '' : undefined;
      a = s.charCodeAt(i);
      return a < 0xd800 || a > 0xdbff || i + 1 === l || (b = s.charCodeAt(i + 1)) < 0xdc00 || b > 0xdfff ? TO_STRING ? s.charAt(i) : a : TO_STRING ? s.slice(i, i + 2) : (a - 0xd800 << 10) + (b - 0xdc00) + 0x10000;
    };
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("6e", ["4e", "82", "5b", "65", "61", "79", "62", "7d", "66", "81", "5e", "68", "69", "6d", "3d"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var $ = require("4e"),
      hide = require("82"),
      ctx = require("5b"),
      species = require("65"),
      strictNew = require("61"),
      defined = require("79"),
      forOf = require("62"),
      step = require("7d"),
      ID = require("66")('id'),
      $has = require("81"),
      isObject = require("5e"),
      isExtensible = Object.isExtensible || isObject,
      SUPPORT_DESC = require("68"),
      SIZE = SUPPORT_DESC ? '_s' : 'size',
      id = 0;
  var fastKey = function(it, create) {
    if (!isObject(it))
      return typeof it == 'symbol' ? it : (typeof it == 'string' ? 'S' : 'P') + it;
    if (!$has(it, ID)) {
      if (!isExtensible(it))
        return 'F';
      if (!create)
        return 'E';
      hide(it, ID, ++id);
    }
    return 'O' + it[ID];
  };
  var getEntry = function(that, key) {
    var index = fastKey(key),
        entry;
    if (index !== 'F')
      return that._i[index];
    for (entry = that._f; entry; entry = entry.n) {
      if (entry.k == key)
        return entry;
    }
  };
  module.exports = {
    getConstructor: function(wrapper, NAME, IS_MAP, ADDER) {
      var C = wrapper(function(that, iterable) {
        strictNew(that, C, NAME);
        that._i = $.create(null);
        that._f = undefined;
        that._l = undefined;
        that[SIZE] = 0;
        if (iterable != undefined)
          forOf(iterable, IS_MAP, that[ADDER], that);
      });
      require("69")(C.prototype, {
        clear: function clear() {
          for (var that = this,
              data = that._i,
              entry = that._f; entry; entry = entry.n) {
            entry.r = true;
            if (entry.p)
              entry.p = entry.p.n = undefined;
            delete data[entry.i];
          }
          that._f = that._l = undefined;
          that[SIZE] = 0;
        },
        'delete': function(key) {
          var that = this,
              entry = getEntry(that, key);
          if (entry) {
            var next = entry.n,
                prev = entry.p;
            delete that._i[entry.i];
            entry.r = true;
            if (prev)
              prev.n = next;
            if (next)
              next.p = prev;
            if (that._f == entry)
              that._f = next;
            if (that._l == entry)
              that._l = prev;
            that[SIZE]--;
          }
          return !!entry;
        },
        forEach: function forEach(callbackfn) {
          var f = ctx(callbackfn, arguments[1], 3),
              entry;
          while (entry = entry ? entry.n : this._f) {
            f(entry.v, entry.k, this);
            while (entry && entry.r)
              entry = entry.p;
          }
        },
        has: function has(key) {
          return !!getEntry(this, key);
        }
      });
      if (SUPPORT_DESC)
        $.setDesc(C.prototype, 'size', {get: function() {
            return defined(this[SIZE]);
          }});
      return C;
    },
    def: function(that, key, value) {
      var entry = getEntry(that, key),
          prev,
          index;
      if (entry) {
        entry.v = value;
      } else {
        that._l = entry = {
          i: index = fastKey(key, true),
          k: key,
          v: value,
          p: prev = that._l,
          n: undefined,
          r: false
        };
        if (!that._f)
          that._f = entry;
        if (prev)
          prev.n = entry;
        that[SIZE]++;
        if (index !== 'F')
          that._i[index] = entry;
      }
      return that;
    },
    getEntry: getEntry,
    setStrong: function(C, NAME, IS_MAP) {
      require("6d")(C, NAME, function(iterated, kind) {
        this._t = iterated;
        this._k = kind;
        this._l = undefined;
      }, function() {
        var that = this,
            kind = that._k,
            entry = that._l;
        while (entry && entry.r)
          entry = entry.p;
        if (!that._t || !(that._l = entry = entry ? entry.n : that._t._f)) {
          that._t = undefined;
          return step(1);
        }
        if (kind == 'keys')
          return step(0, entry.k);
        if (kind == 'values')
          return step(0, entry.v);
        return step(0, [entry.k, entry.v]);
      }, IS_MAP ? 'entries' : 'values', !IS_MAP, true);
      species(C);
      species(require("3d")[NAME]);
    }
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("6f", ["4e", "5d", "82", "62", "61", "5a", "68", "78", "69", "6a"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var $ = require("4e"),
      $def = require("5d"),
      hide = require("82"),
      forOf = require("62"),
      strictNew = require("61");
  module.exports = function(NAME, wrapper, methods, common, IS_MAP, IS_WEAK) {
    var Base = require("5a")[NAME],
        C = Base,
        ADDER = IS_MAP ? 'set' : 'add',
        proto = C && C.prototype,
        O = {};
    if (!require("68") || typeof C != 'function' || !(IS_WEAK || proto.forEach && !require("78")(function() {
      new C().entries().next();
    }))) {
      C = common.getConstructor(wrapper, NAME, IS_MAP, ADDER);
      require("69")(C.prototype, methods);
    } else {
      C = wrapper(function(target, iterable) {
        strictNew(target, C, NAME);
        target._c = new Base;
        if (iterable != undefined)
          forOf(iterable, IS_MAP, target[ADDER], target);
      });
      $.each.call('add,clear,delete,forEach,get,has,set,keys,values,entries'.split(','), function(KEY) {
        var chain = KEY == 'add' || KEY == 'set';
        if (KEY in proto && !(IS_WEAK && KEY == 'clear'))
          hide(C.prototype, KEY, function(a, b) {
            var result = this._c[KEY](a === 0 ? 0 : a, b);
            return chain ? this : result;
          });
      });
      if ('size' in proto)
        $.setDesc(C.prototype, 'size', {get: function() {
            return this._c.size;
          }});
    }
    require("6a")(C, NAME);
    O[NAME] = C;
    $def($def.G + $def.W + $def.F, O);
    if (!IS_WEAK)
      common.setStrong(C, NAME, IS_MAP);
    return C;
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("70", ["62", "5c"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var forOf = require("62"),
      classof = require("5c");
  module.exports = function(NAME) {
    return function toJSON() {
      if (classof(this) != NAME)
        throw TypeError(NAME + "#toJSON isn't generic");
      var arr = [];
      forOf(this, false, arr.push, arr);
      return arr;
    };
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("71", ["5c", "4a", "58", "3d"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var classof = require("5c"),
      ITERATOR = require("4a")('iterator'),
      Iterators = require("58");
  module.exports = require("3d").getIteratorMethod = function(it) {
    if (it != undefined)
      return it[ITERATOR] || it['@@iterator'] || Iterators[classof(it)];
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("72", ["85"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  module.exports = $__System._nodeRequire ? process : require("85");
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("73", ["5a"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var global = require("5a"),
      SHARED = '__core-js_shared__',
      store = global[SHARED] || (global[SHARED] = {});
  module.exports = function(key) {
    return store[key] || (store[key] = {});
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("75", ["58", "4a"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var Iterators = require("58"),
      ITERATOR = require("4a")('iterator');
  module.exports = function(it) {
    return (Iterators.Array || Array.prototype[ITERATOR]) === it;
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("76", ["84"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var toInteger = require("84"),
      min = Math.min;
  module.exports = function(it) {
    return it > 0 ? min(toInteger(it), 0x1fffffffffffff) : 0;
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("74", ["5f"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var anObject = require("5f");
  module.exports = function(iterator, fn, value, entries) {
    try {
      return entries ? fn(anObject(value)[0], value[1]) : fn(value);
    } catch (e) {
      var ret = iterator['return'];
      if (ret !== undefined)
        anObject(ret.call(iterator));
      throw e;
    }
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("77", ["86", "79"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var IObject = require("86"),
      defined = require("79");
  module.exports = function(it) {
    return IObject(defined(it));
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("7b", ["87"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  module.exports = require("87");
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("7a", ["88", "49"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  (function(process) {
    "use strict";
    var uniq = require("88");
    function innerFill(order, proc, body) {
      var dimension = order.length,
          nargs = proc.arrayArgs.length,
          has_index = proc.indexArgs.length > 0,
          code = [],
          vars = [],
          idx = 0,
          pidx = 0,
          i,
          j;
      for (i = 0; i < dimension; ++i) {
        vars.push(["i", i, "=0"].join(""));
      }
      for (j = 0; j < nargs; ++j) {
        for (i = 0; i < dimension; ++i) {
          pidx = idx;
          idx = order[i];
          if (i === 0) {
            vars.push(["d", j, "s", i, "=t", j, "p", idx].join(""));
          } else {
            vars.push(["d", j, "s", i, "=(t", j, "p", idx, "-s", pidx, "*t", j, "p", pidx, ")"].join(""));
          }
        }
      }
      code.push("var " + vars.join(","));
      for (i = dimension - 1; i >= 0; --i) {
        idx = order[i];
        code.push(["for(i", i, "=0;i", i, "<s", idx, ";++i", i, "){"].join(""));
      }
      code.push(body);
      for (i = 0; i < dimension; ++i) {
        pidx = idx;
        idx = order[i];
        for (j = 0; j < nargs; ++j) {
          code.push(["p", j, "+=d", j, "s", i].join(""));
        }
        if (has_index) {
          if (i > 0) {
            code.push(["index[", pidx, "]-=s", pidx].join(""));
          }
          code.push(["++index[", idx, "]"].join(""));
        }
        code.push("}");
      }
      return code.join("\n");
    }
    function outerFill(matched, order, proc, body) {
      var dimension = order.length,
          nargs = proc.arrayArgs.length,
          blockSize = proc.blockSize,
          has_index = proc.indexArgs.length > 0,
          code = [];
      for (var i = 0; i < nargs; ++i) {
        code.push(["var offset", i, "=p", i].join(""));
      }
      for (var i = matched; i < dimension; ++i) {
        code.push(["for(var j" + i + "=SS[", order[i], "]|0;j", i, ">0;){"].join(""));
        code.push(["if(j", i, "<", blockSize, "){"].join(""));
        code.push(["s", order[i], "=j", i].join(""));
        code.push(["j", i, "=0"].join(""));
        code.push(["}else{s", order[i], "=", blockSize].join(""));
        code.push(["j", i, "-=", blockSize, "}"].join(""));
        if (has_index) {
          code.push(["index[", order[i], "]=j", i].join(""));
        }
      }
      for (var i = 0; i < nargs; ++i) {
        var indexStr = ["offset" + i];
        for (var j = matched; j < dimension; ++j) {
          indexStr.push(["j", j, "*t", i, "p", order[j]].join(""));
        }
        code.push(["p", i, "=(", indexStr.join("+"), ")"].join(""));
      }
      code.push(innerFill(order, proc, body));
      for (var i = matched; i < dimension; ++i) {
        code.push("}");
      }
      return code.join("\n");
    }
    function countMatches(orders) {
      var matched = 0,
          dimension = orders[0].length;
      while (matched < dimension) {
        for (var j = 1; j < orders.length; ++j) {
          if (orders[j][matched] !== orders[0][matched]) {
            return matched;
          }
        }
        ++matched;
      }
      return matched;
    }
    function processBlock(block, proc, dtypes) {
      var code = block.body;
      var pre = [];
      var post = [];
      for (var i = 0; i < block.args.length; ++i) {
        var carg = block.args[i];
        if (carg.count <= 0) {
          continue;
        }
        var re = new RegExp(carg.name, "g");
        var ptrStr = "";
        var arrNum = proc.arrayArgs.indexOf(i);
        switch (proc.argTypes[i]) {
          case "offset":
            var offArgIndex = proc.offsetArgIndex.indexOf(i);
            var offArg = proc.offsetArgs[offArgIndex];
            arrNum = offArg.array;
            ptrStr = "+q" + offArgIndex;
          case "array":
            ptrStr = "p" + arrNum + ptrStr;
            var localStr = "l" + i;
            var arrStr = "a" + arrNum;
            if (proc.arrayBlockIndices[arrNum] === 0) {
              if (carg.count === 1) {
                if (dtypes[arrNum] === "generic") {
                  if (carg.lvalue) {
                    pre.push(["var ", localStr, "=", arrStr, ".get(", ptrStr, ")"].join(""));
                    code = code.replace(re, localStr);
                    post.push([arrStr, ".set(", ptrStr, ",", localStr, ")"].join(""));
                  } else {
                    code = code.replace(re, [arrStr, ".get(", ptrStr, ")"].join(""));
                  }
                } else {
                  code = code.replace(re, [arrStr, "[", ptrStr, "]"].join(""));
                }
              } else if (dtypes[arrNum] === "generic") {
                pre.push(["var ", localStr, "=", arrStr, ".get(", ptrStr, ")"].join(""));
                code = code.replace(re, localStr);
                if (carg.lvalue) {
                  post.push([arrStr, ".set(", ptrStr, ",", localStr, ")"].join(""));
                }
              } else {
                pre.push(["var ", localStr, "=", arrStr, "[", ptrStr, "]"].join(""));
                code = code.replace(re, localStr);
                if (carg.lvalue) {
                  post.push([arrStr, "[", ptrStr, "]=", localStr].join(""));
                }
              }
            } else {
              var reStrArr = [carg.name],
                  ptrStrArr = [ptrStr];
              for (var j = 0; j < Math.abs(proc.arrayBlockIndices[arrNum]); j++) {
                reStrArr.push("\\s*\\[([^\\]]+)\\]");
                ptrStrArr.push("$" + (j + 1) + "*t" + arrNum + "b" + j);
              }
              re = new RegExp(reStrArr.join(""), "g");
              ptrStr = ptrStrArr.join("+");
              if (dtypes[arrNum] === "generic") {
                throw new Error("cwise: Generic arrays not supported in combination with blocks!");
              } else {
                code = code.replace(re, [arrStr, "[", ptrStr, "]"].join(""));
              }
            }
            break;
          case "scalar":
            code = code.replace(re, "Y" + proc.scalarArgs.indexOf(i));
            break;
          case "index":
            code = code.replace(re, "index");
            break;
          case "shape":
            code = code.replace(re, "shape");
            break;
        }
      }
      return [pre.join("\n"), code, post.join("\n")].join("\n").trim();
    }
    function typeSummary(dtypes) {
      var summary = new Array(dtypes.length);
      var allEqual = true;
      for (var i = 0; i < dtypes.length; ++i) {
        var t = dtypes[i];
        var digits = t.match(/\d+/);
        if (!digits) {
          digits = "";
        } else {
          digits = digits[0];
        }
        if (t.charAt(0) === 0) {
          summary[i] = "u" + t.charAt(1) + digits;
        } else {
          summary[i] = t.charAt(0) + digits;
        }
        if (i > 0) {
          allEqual = allEqual && summary[i] === summary[i - 1];
        }
      }
      if (allEqual) {
        return summary[0];
      }
      return summary.join("");
    }
    function generateCWiseOp(proc, typesig) {
      var dimension = (typesig[1].length - Math.abs(proc.arrayBlockIndices[0])) | 0;
      var orders = new Array(proc.arrayArgs.length);
      var dtypes = new Array(proc.arrayArgs.length);
      for (var i = 0; i < proc.arrayArgs.length; ++i) {
        dtypes[i] = typesig[2 * i];
        orders[i] = typesig[2 * i + 1];
      }
      var blockBegin = [],
          blockEnd = [];
      var loopBegin = [],
          loopEnd = [];
      var loopOrders = [];
      for (var i = 0; i < proc.arrayArgs.length; ++i) {
        if (proc.arrayBlockIndices[i] < 0) {
          loopBegin.push(0);
          loopEnd.push(dimension);
          blockBegin.push(dimension);
          blockEnd.push(dimension + proc.arrayBlockIndices[i]);
        } else {
          loopBegin.push(proc.arrayBlockIndices[i]);
          loopEnd.push(proc.arrayBlockIndices[i] + dimension);
          blockBegin.push(0);
          blockEnd.push(proc.arrayBlockIndices[i]);
        }
        var newOrder = [];
        for (var j = 0; j < orders[i].length; j++) {
          if (loopBegin[i] <= orders[i][j] && orders[i][j] < loopEnd[i]) {
            newOrder.push(orders[i][j] - loopBegin[i]);
          }
        }
        loopOrders.push(newOrder);
      }
      var arglist = ["SS"];
      var code = ["'use strict'"];
      var vars = [];
      for (var j = 0; j < dimension; ++j) {
        vars.push(["s", j, "=SS[", j, "]"].join(""));
      }
      for (var i = 0; i < proc.arrayArgs.length; ++i) {
        arglist.push("a" + i);
        arglist.push("t" + i);
        arglist.push("p" + i);
        for (var j = 0; j < dimension; ++j) {
          vars.push(["t", i, "p", j, "=t", i, "[", loopBegin[i] + j, "]"].join(""));
        }
        for (var j = 0; j < Math.abs(proc.arrayBlockIndices[i]); ++j) {
          vars.push(["t", i, "b", j, "=t", i, "[", blockBegin[i] + j, "]"].join(""));
        }
      }
      for (var i = 0; i < proc.scalarArgs.length; ++i) {
        arglist.push("Y" + i);
      }
      if (proc.shapeArgs.length > 0) {
        vars.push("shape=SS.slice(0)");
      }
      if (proc.indexArgs.length > 0) {
        var zeros = new Array(dimension);
        for (var i = 0; i < dimension; ++i) {
          zeros[i] = "0";
        }
        vars.push(["index=[", zeros.join(","), "]"].join(""));
      }
      for (var i = 0; i < proc.offsetArgs.length; ++i) {
        var off_arg = proc.offsetArgs[i];
        var init_string = [];
        for (var j = 0; j < off_arg.offset.length; ++j) {
          if (off_arg.offset[j] === 0) {
            continue;
          } else if (off_arg.offset[j] === 1) {
            init_string.push(["t", off_arg.array, "p", j].join(""));
          } else {
            init_string.push([off_arg.offset[j], "*t", off_arg.array, "p", j].join(""));
          }
        }
        if (init_string.length === 0) {
          vars.push("q" + i + "=0");
        } else {
          vars.push(["q", i, "=", init_string.join("+")].join(""));
        }
      }
      var thisVars = uniq([].concat(proc.pre.thisVars).concat(proc.body.thisVars).concat(proc.post.thisVars));
      vars = vars.concat(thisVars);
      code.push("var " + vars.join(","));
      for (var i = 0; i < proc.arrayArgs.length; ++i) {
        code.push("p" + i + "|=0");
      }
      if (proc.pre.body.length > 3) {
        code.push(processBlock(proc.pre, proc, dtypes));
      }
      var body = processBlock(proc.body, proc, dtypes);
      var matched = countMatches(loopOrders);
      if (matched < dimension) {
        code.push(outerFill(matched, loopOrders[0], proc, body));
      } else {
        code.push(innerFill(loopOrders[0], proc, body));
      }
      if (proc.post.body.length > 3) {
        code.push(processBlock(proc.post, proc, dtypes));
      }
      if (proc.debug) {
        console.log("-----Generated cwise routine for ", typesig, ":\n" + code.join("\n") + "\n----------");
      }
      var loopName = [(proc.funcName || "unnamed"), "_cwise_loop_", orders[0].join("s"), "m", matched, typeSummary(dtypes)].join("");
      var f = new Function(["function ", loopName, "(", arglist.join(","), "){", code.join("\n"), "} return ", loopName].join(""));
      return f();
    }
    module.exports = generateCWiseOp;
  })(require("49"));
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("79", [], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  module.exports = function(it) {
    if (it == undefined)
      throw TypeError("Can't call method on  " + it);
    return it;
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("78", [], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  module.exports = function(exec) {
    try {
      return !!exec();
    } catch (e) {
      return true;
    }
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("7c", [], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  module.exports = function() {};
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("7f", ["5b", "89", "8a", "8b", "5a", "7e", "49"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  (function(process) {
    'use strict';
    var ctx = require("5b"),
        invoke = require("89"),
        html = require("8a"),
        cel = require("8b"),
        global = require("5a"),
        process = global.process,
        setTask = global.setImmediate,
        clearTask = global.clearImmediate,
        MessageChannel = global.MessageChannel,
        counter = 0,
        queue = {},
        ONREADYSTATECHANGE = 'onreadystatechange',
        defer,
        channel,
        port;
    var run = function() {
      var id = +this;
      if (queue.hasOwnProperty(id)) {
        var fn = queue[id];
        delete queue[id];
        fn();
      }
    };
    var listner = function(event) {
      run.call(event.data);
    };
    if (!setTask || !clearTask) {
      setTask = function setImmediate(fn) {
        var args = [],
            i = 1;
        while (arguments.length > i)
          args.push(arguments[i++]);
        queue[++counter] = function() {
          invoke(typeof fn == 'function' ? fn : Function(fn), args);
        };
        defer(counter);
        return counter;
      };
      clearTask = function clearImmediate(id) {
        delete queue[id];
      };
      if (require("7e")(process) == 'process') {
        defer = function(id) {
          process.nextTick(ctx(run, id, 1));
        };
      } else if (MessageChannel) {
        channel = new MessageChannel;
        port = channel.port2;
        channel.port1.onmessage = listner;
        defer = ctx(port.postMessage, port, 1);
      } else if (global.addEventListener && typeof postMessage == 'function' && !global.importScript) {
        defer = function(id) {
          global.postMessage(id + '', '*');
        };
        global.addEventListener('message', listner, false);
      } else if (ONREADYSTATECHANGE in cel('script')) {
        defer = function(id) {
          html.appendChild(cel('script'))[ONREADYSTATECHANGE] = function() {
            html.removeChild(this);
            run.call(id);
          };
        };
      } else {
        defer = function(id) {
          setTimeout(ctx(run, id, 1), 0);
        };
      }
    }
    module.exports = {
      set: setTask,
      clear: clearTask
    };
  })(require("49"));
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("7e", [], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var toString = {}.toString;
  module.exports = function(it) {
    return toString.call(it).slice(8, -1);
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("80", ["82"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  module.exports = require("82");
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("7d", [], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  module.exports = function(done, value) {
    return {
      value: value,
      done: !!done
    };
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("82", ["4e", "8c", "68"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var $ = require("4e"),
      createDesc = require("8c");
  module.exports = require("68") ? function(object, key, value) {
    return $.setDesc(object, key, createDesc(1, value));
  } : function(object, key, value) {
    object[key] = value;
    return object;
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("81", [], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var hasOwnProperty = {}.hasOwnProperty;
  module.exports = function(it, key) {
    return hasOwnProperty.call(it, key);
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("84", [], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var ceil = Math.ceil,
      floor = Math.floor;
  module.exports = function(it) {
    return isNaN(it = +it) ? 0 : (it > 0 ? floor : ceil)(it);
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("83", ["4e", "82", "4a", "8c", "6a"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  'use strict';
  var $ = require("4e"),
      IteratorPrototype = {};
  require("82")(IteratorPrototype, require("4a")('iterator'), function() {
    return this;
  });
  module.exports = function(Constructor, NAME, next) {
    Constructor.prototype = $.create(IteratorPrototype, {next: require("8c")(1, next)});
    require("6a")(Constructor, NAME + ' Iterator');
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("85", ["8d"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  module.exports = require("8d");
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("86", ["7e"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var cof = require("7e");
  module.exports = 0 in Object('z') ? Object : function(it) {
    return cof(it) == 'String' ? it.split('') : Object(it);
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("88", ["8e"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  module.exports = require("8e");
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("87", ["8f"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  module.exports = $__System._nodeRequire ? $__System._nodeRequire('buffer') : require("8f");
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("8b", ["5e", "5a"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var isObject = require("5e"),
      document = require("5a").document,
      is = isObject(document) && isObject(document.createElement);
  module.exports = function(it) {
    return is ? document.createElement(it) : {};
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("8a", ["5a"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  module.exports = require("5a").document && document.documentElement;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("89", [], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  module.exports = function(fn, args, that) {
    var un = that === undefined;
    switch (args.length) {
      case 0:
        return un ? fn() : fn.call(that);
      case 1:
        return un ? fn(args[0]) : fn.call(that, args[0]);
      case 2:
        return un ? fn(args[0], args[1]) : fn.call(that, args[0], args[1]);
      case 3:
        return un ? fn(args[0], args[1], args[2]) : fn.call(that, args[0], args[1], args[2]);
      case 4:
        return un ? fn(args[0], args[1], args[2], args[3]) : fn.call(that, args[0], args[1], args[2], args[3]);
    }
    return fn.apply(that, args);
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("8c", [], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  module.exports = function(bitmap, value) {
    return {
      enumerable: !(bitmap & 1),
      configurable: !(bitmap & 2),
      writable: !(bitmap & 4),
      value: value
    };
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("8d", [], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var process = module.exports = {};
  var queue = [];
  var draining = false;
  var currentQueue;
  var queueIndex = -1;
  function cleanUpNextTick() {
    draining = false;
    if (currentQueue.length) {
      queue = currentQueue.concat(queue);
    } else {
      queueIndex = -1;
    }
    if (queue.length) {
      drainQueue();
    }
  }
  function drainQueue() {
    if (draining) {
      return;
    }
    var timeout = setTimeout(cleanUpNextTick);
    draining = true;
    var len = queue.length;
    while (len) {
      currentQueue = queue;
      queue = [];
      while (++queueIndex < len) {
        if (currentQueue) {
          currentQueue[queueIndex].run();
        }
      }
      queueIndex = -1;
      len = queue.length;
    }
    currentQueue = null;
    draining = false;
    clearTimeout(timeout);
  }
  process.nextTick = function(fun) {
    var args = new Array(arguments.length - 1);
    if (arguments.length > 1) {
      for (var i = 1; i < arguments.length; i++) {
        args[i - 1] = arguments[i];
      }
    }
    queue.push(new Item(fun, args));
    if (queue.length === 1 && !draining) {
      setTimeout(drainQueue, 0);
    }
  };
  function Item(fun, array) {
    this.fun = fun;
    this.array = array;
  }
  Item.prototype.run = function() {
    this.fun.apply(null, this.array);
  };
  process.title = 'browser';
  process.browser = true;
  process.env = {};
  process.argv = [];
  process.version = '';
  process.versions = {};
  function noop() {}
  process.on = noop;
  process.addListener = noop;
  process.once = noop;
  process.off = noop;
  process.removeListener = noop;
  process.removeAllListeners = noop;
  process.emit = noop;
  process.binding = function(name) {
    throw new Error('process.binding is not supported');
  };
  process.cwd = function() {
    return '/';
  };
  process.chdir = function(dir) {
    throw new Error('process.chdir is not supported');
  };
  process.umask = function() {
    return 0;
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("8f", ["90"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  module.exports = require("90");
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("8e", [], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  "use strict";
  function unique_pred(list, compare) {
    var ptr = 1,
        len = list.length,
        a = list[0],
        b = list[0];
    for (var i = 1; i < len; ++i) {
      b = a;
      a = list[i];
      if (compare(a, b)) {
        if (i === ptr) {
          ptr++;
          continue;
        }
        list[ptr++] = a;
      }
    }
    list.length = ptr;
    return list;
  }
  function unique_eq(list) {
    var ptr = 1,
        len = list.length,
        a = list[0],
        b = list[0];
    for (var i = 1; i < len; ++i, b = a) {
      b = a;
      a = list[i];
      if (a !== b) {
        if (i === ptr) {
          ptr++;
          continue;
        }
        list[ptr++] = a;
      }
    }
    list.length = ptr;
    return list;
  }
  function unique(list, compare, sorted) {
    if (list.length === 0) {
      return list;
    }
    if (compare) {
      if (!sorted) {
        list.sort(compare);
      }
      return unique_pred(list, compare);
    }
    if (!sorted) {
      list.sort();
    }
    return unique_eq(list);
  }
  module.exports = unique;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("90", ["91", "92", "93"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var base64 = require("91");
  var ieee754 = require("92");
  var isArray = require("93");
  exports.Buffer = Buffer;
  exports.SlowBuffer = SlowBuffer;
  exports.INSPECT_MAX_BYTES = 50;
  Buffer.poolSize = 8192;
  var rootParent = {};
  Buffer.TYPED_ARRAY_SUPPORT = global.TYPED_ARRAY_SUPPORT !== undefined ? global.TYPED_ARRAY_SUPPORT : (function() {
    function Bar() {}
    try {
      var arr = new Uint8Array(1);
      arr.foo = function() {
        return 42;
      };
      arr.constructor = Bar;
      return arr.foo() === 42 && arr.constructor === Bar && typeof arr.subarray === 'function' && arr.subarray(1, 1).byteLength === 0;
    } catch (e) {
      return false;
    }
  })();
  function kMaxLength() {
    return Buffer.TYPED_ARRAY_SUPPORT ? 0x7fffffff : 0x3fffffff;
  }
  function Buffer(arg) {
    if (!(this instanceof Buffer)) {
      if (arguments.length > 1)
        return new Buffer(arg, arguments[1]);
      return new Buffer(arg);
    }
    this.length = 0;
    this.parent = undefined;
    if (typeof arg === 'number') {
      return fromNumber(this, arg);
    }
    if (typeof arg === 'string') {
      return fromString(this, arg, arguments.length > 1 ? arguments[1] : 'utf8');
    }
    return fromObject(this, arg);
  }
  function fromNumber(that, length) {
    that = allocate(that, length < 0 ? 0 : checked(length) | 0);
    if (!Buffer.TYPED_ARRAY_SUPPORT) {
      for (var i = 0; i < length; i++) {
        that[i] = 0;
      }
    }
    return that;
  }
  function fromString(that, string, encoding) {
    if (typeof encoding !== 'string' || encoding === '')
      encoding = 'utf8';
    var length = byteLength(string, encoding) | 0;
    that = allocate(that, length);
    that.write(string, encoding);
    return that;
  }
  function fromObject(that, object) {
    if (Buffer.isBuffer(object))
      return fromBuffer(that, object);
    if (isArray(object))
      return fromArray(that, object);
    if (object == null) {
      throw new TypeError('must start with number, buffer, array or string');
    }
    if (typeof ArrayBuffer !== 'undefined') {
      if (object.buffer instanceof ArrayBuffer) {
        return fromTypedArray(that, object);
      }
      if (object instanceof ArrayBuffer) {
        return fromArrayBuffer(that, object);
      }
    }
    if (object.length)
      return fromArrayLike(that, object);
    return fromJsonObject(that, object);
  }
  function fromBuffer(that, buffer) {
    var length = checked(buffer.length) | 0;
    that = allocate(that, length);
    buffer.copy(that, 0, 0, length);
    return that;
  }
  function fromArray(that, array) {
    var length = checked(array.length) | 0;
    that = allocate(that, length);
    for (var i = 0; i < length; i += 1) {
      that[i] = array[i] & 255;
    }
    return that;
  }
  function fromTypedArray(that, array) {
    var length = checked(array.length) | 0;
    that = allocate(that, length);
    for (var i = 0; i < length; i += 1) {
      that[i] = array[i] & 255;
    }
    return that;
  }
  function fromArrayBuffer(that, array) {
    if (Buffer.TYPED_ARRAY_SUPPORT) {
      array.byteLength;
      that = Buffer._augment(new Uint8Array(array));
    } else {
      that = fromTypedArray(that, new Uint8Array(array));
    }
    return that;
  }
  function fromArrayLike(that, array) {
    var length = checked(array.length) | 0;
    that = allocate(that, length);
    for (var i = 0; i < length; i += 1) {
      that[i] = array[i] & 255;
    }
    return that;
  }
  function fromJsonObject(that, object) {
    var array;
    var length = 0;
    if (object.type === 'Buffer' && isArray(object.data)) {
      array = object.data;
      length = checked(array.length) | 0;
    }
    that = allocate(that, length);
    for (var i = 0; i < length; i += 1) {
      that[i] = array[i] & 255;
    }
    return that;
  }
  if (Buffer.TYPED_ARRAY_SUPPORT) {
    Buffer.prototype.__proto__ = Uint8Array.prototype;
    Buffer.__proto__ = Uint8Array;
  }
  function allocate(that, length) {
    if (Buffer.TYPED_ARRAY_SUPPORT) {
      that = Buffer._augment(new Uint8Array(length));
      that.__proto__ = Buffer.prototype;
    } else {
      that.length = length;
      that._isBuffer = true;
    }
    var fromPool = length !== 0 && length <= Buffer.poolSize >>> 1;
    if (fromPool)
      that.parent = rootParent;
    return that;
  }
  function checked(length) {
    if (length >= kMaxLength()) {
      throw new RangeError('Attempt to allocate Buffer larger than maximum ' + 'size: 0x' + kMaxLength().toString(16) + ' bytes');
    }
    return length | 0;
  }
  function SlowBuffer(subject, encoding) {
    if (!(this instanceof SlowBuffer))
      return new SlowBuffer(subject, encoding);
    var buf = new Buffer(subject, encoding);
    delete buf.parent;
    return buf;
  }
  Buffer.isBuffer = function isBuffer(b) {
    return !!(b != null && b._isBuffer);
  };
  Buffer.compare = function compare(a, b) {
    if (!Buffer.isBuffer(a) || !Buffer.isBuffer(b)) {
      throw new TypeError('Arguments must be Buffers');
    }
    if (a === b)
      return 0;
    var x = a.length;
    var y = b.length;
    var i = 0;
    var len = Math.min(x, y);
    while (i < len) {
      if (a[i] !== b[i])
        break;
      ++i;
    }
    if (i !== len) {
      x = a[i];
      y = b[i];
    }
    if (x < y)
      return -1;
    if (y < x)
      return 1;
    return 0;
  };
  Buffer.isEncoding = function isEncoding(encoding) {
    switch (String(encoding).toLowerCase()) {
      case 'hex':
      case 'utf8':
      case 'utf-8':
      case 'ascii':
      case 'binary':
      case 'base64':
      case 'raw':
      case 'ucs2':
      case 'ucs-2':
      case 'utf16le':
      case 'utf-16le':
        return true;
      default:
        return false;
    }
  };
  Buffer.concat = function concat(list, length) {
    if (!isArray(list))
      throw new TypeError('list argument must be an Array of Buffers.');
    if (list.length === 0) {
      return new Buffer(0);
    }
    var i;
    if (length === undefined) {
      length = 0;
      for (i = 0; i < list.length; i++) {
        length += list[i].length;
      }
    }
    var buf = new Buffer(length);
    var pos = 0;
    for (i = 0; i < list.length; i++) {
      var item = list[i];
      item.copy(buf, pos);
      pos += item.length;
    }
    return buf;
  };
  function byteLength(string, encoding) {
    if (typeof string !== 'string')
      string = '' + string;
    var len = string.length;
    if (len === 0)
      return 0;
    var loweredCase = false;
    for (; ; ) {
      switch (encoding) {
        case 'ascii':
        case 'binary':
        case 'raw':
        case 'raws':
          return len;
        case 'utf8':
        case 'utf-8':
          return utf8ToBytes(string).length;
        case 'ucs2':
        case 'ucs-2':
        case 'utf16le':
        case 'utf-16le':
          return len * 2;
        case 'hex':
          return len >>> 1;
        case 'base64':
          return base64ToBytes(string).length;
        default:
          if (loweredCase)
            return utf8ToBytes(string).length;
          encoding = ('' + encoding).toLowerCase();
          loweredCase = true;
      }
    }
  }
  Buffer.byteLength = byteLength;
  Buffer.prototype.length = undefined;
  Buffer.prototype.parent = undefined;
  function slowToString(encoding, start, end) {
    var loweredCase = false;
    start = start | 0;
    end = end === undefined || end === Infinity ? this.length : end | 0;
    if (!encoding)
      encoding = 'utf8';
    if (start < 0)
      start = 0;
    if (end > this.length)
      end = this.length;
    if (end <= start)
      return '';
    while (true) {
      switch (encoding) {
        case 'hex':
          return hexSlice(this, start, end);
        case 'utf8':
        case 'utf-8':
          return utf8Slice(this, start, end);
        case 'ascii':
          return asciiSlice(this, start, end);
        case 'binary':
          return binarySlice(this, start, end);
        case 'base64':
          return base64Slice(this, start, end);
        case 'ucs2':
        case 'ucs-2':
        case 'utf16le':
        case 'utf-16le':
          return utf16leSlice(this, start, end);
        default:
          if (loweredCase)
            throw new TypeError('Unknown encoding: ' + encoding);
          encoding = (encoding + '').toLowerCase();
          loweredCase = true;
      }
    }
  }
  Buffer.prototype.toString = function toString() {
    var length = this.length | 0;
    if (length === 0)
      return '';
    if (arguments.length === 0)
      return utf8Slice(this, 0, length);
    return slowToString.apply(this, arguments);
  };
  Buffer.prototype.equals = function equals(b) {
    if (!Buffer.isBuffer(b))
      throw new TypeError('Argument must be a Buffer');
    if (this === b)
      return true;
    return Buffer.compare(this, b) === 0;
  };
  Buffer.prototype.inspect = function inspect() {
    var str = '';
    var max = exports.INSPECT_MAX_BYTES;
    if (this.length > 0) {
      str = this.toString('hex', 0, max).match(/.{2}/g).join(' ');
      if (this.length > max)
        str += ' ... ';
    }
    return '<Buffer ' + str + '>';
  };
  Buffer.prototype.compare = function compare(b) {
    if (!Buffer.isBuffer(b))
      throw new TypeError('Argument must be a Buffer');
    if (this === b)
      return 0;
    return Buffer.compare(this, b);
  };
  Buffer.prototype.indexOf = function indexOf(val, byteOffset) {
    if (byteOffset > 0x7fffffff)
      byteOffset = 0x7fffffff;
    else if (byteOffset < -0x80000000)
      byteOffset = -0x80000000;
    byteOffset >>= 0;
    if (this.length === 0)
      return -1;
    if (byteOffset >= this.length)
      return -1;
    if (byteOffset < 0)
      byteOffset = Math.max(this.length + byteOffset, 0);
    if (typeof val === 'string') {
      if (val.length === 0)
        return -1;
      return String.prototype.indexOf.call(this, val, byteOffset);
    }
    if (Buffer.isBuffer(val)) {
      return arrayIndexOf(this, val, byteOffset);
    }
    if (typeof val === 'number') {
      if (Buffer.TYPED_ARRAY_SUPPORT && Uint8Array.prototype.indexOf === 'function') {
        return Uint8Array.prototype.indexOf.call(this, val, byteOffset);
      }
      return arrayIndexOf(this, [val], byteOffset);
    }
    function arrayIndexOf(arr, val, byteOffset) {
      var foundIndex = -1;
      for (var i = 0; byteOffset + i < arr.length; i++) {
        if (arr[byteOffset + i] === val[foundIndex === -1 ? 0 : i - foundIndex]) {
          if (foundIndex === -1)
            foundIndex = i;
          if (i - foundIndex + 1 === val.length)
            return byteOffset + foundIndex;
        } else {
          foundIndex = -1;
        }
      }
      return -1;
    }
    throw new TypeError('val must be string, number or Buffer');
  };
  Buffer.prototype.get = function get(offset) {
    console.log('.get() is deprecated. Access using array indexes instead.');
    return this.readUInt8(offset);
  };
  Buffer.prototype.set = function set(v, offset) {
    console.log('.set() is deprecated. Access using array indexes instead.');
    return this.writeUInt8(v, offset);
  };
  function hexWrite(buf, string, offset, length) {
    offset = Number(offset) || 0;
    var remaining = buf.length - offset;
    if (!length) {
      length = remaining;
    } else {
      length = Number(length);
      if (length > remaining) {
        length = remaining;
      }
    }
    var strLen = string.length;
    if (strLen % 2 !== 0)
      throw new Error('Invalid hex string');
    if (length > strLen / 2) {
      length = strLen / 2;
    }
    for (var i = 0; i < length; i++) {
      var parsed = parseInt(string.substr(i * 2, 2), 16);
      if (isNaN(parsed))
        throw new Error('Invalid hex string');
      buf[offset + i] = parsed;
    }
    return i;
  }
  function utf8Write(buf, string, offset, length) {
    return blitBuffer(utf8ToBytes(string, buf.length - offset), buf, offset, length);
  }
  function asciiWrite(buf, string, offset, length) {
    return blitBuffer(asciiToBytes(string), buf, offset, length);
  }
  function binaryWrite(buf, string, offset, length) {
    return asciiWrite(buf, string, offset, length);
  }
  function base64Write(buf, string, offset, length) {
    return blitBuffer(base64ToBytes(string), buf, offset, length);
  }
  function ucs2Write(buf, string, offset, length) {
    return blitBuffer(utf16leToBytes(string, buf.length - offset), buf, offset, length);
  }
  Buffer.prototype.write = function write(string, offset, length, encoding) {
    if (offset === undefined) {
      encoding = 'utf8';
      length = this.length;
      offset = 0;
    } else if (length === undefined && typeof offset === 'string') {
      encoding = offset;
      length = this.length;
      offset = 0;
    } else if (isFinite(offset)) {
      offset = offset | 0;
      if (isFinite(length)) {
        length = length | 0;
        if (encoding === undefined)
          encoding = 'utf8';
      } else {
        encoding = length;
        length = undefined;
      }
    } else {
      var swap = encoding;
      encoding = offset;
      offset = length | 0;
      length = swap;
    }
    var remaining = this.length - offset;
    if (length === undefined || length > remaining)
      length = remaining;
    if ((string.length > 0 && (length < 0 || offset < 0)) || offset > this.length) {
      throw new RangeError('attempt to write outside buffer bounds');
    }
    if (!encoding)
      encoding = 'utf8';
    var loweredCase = false;
    for (; ; ) {
      switch (encoding) {
        case 'hex':
          return hexWrite(this, string, offset, length);
        case 'utf8':
        case 'utf-8':
          return utf8Write(this, string, offset, length);
        case 'ascii':
          return asciiWrite(this, string, offset, length);
        case 'binary':
          return binaryWrite(this, string, offset, length);
        case 'base64':
          return base64Write(this, string, offset, length);
        case 'ucs2':
        case 'ucs-2':
        case 'utf16le':
        case 'utf-16le':
          return ucs2Write(this, string, offset, length);
        default:
          if (loweredCase)
            throw new TypeError('Unknown encoding: ' + encoding);
          encoding = ('' + encoding).toLowerCase();
          loweredCase = true;
      }
    }
  };
  Buffer.prototype.toJSON = function toJSON() {
    return {
      type: 'Buffer',
      data: Array.prototype.slice.call(this._arr || this, 0)
    };
  };
  function base64Slice(buf, start, end) {
    if (start === 0 && end === buf.length) {
      return base64.fromByteArray(buf);
    } else {
      return base64.fromByteArray(buf.slice(start, end));
    }
  }
  function utf8Slice(buf, start, end) {
    end = Math.min(buf.length, end);
    var res = [];
    var i = start;
    while (i < end) {
      var firstByte = buf[i];
      var codePoint = null;
      var bytesPerSequence = (firstByte > 0xEF) ? 4 : (firstByte > 0xDF) ? 3 : (firstByte > 0xBF) ? 2 : 1;
      if (i + bytesPerSequence <= end) {
        var secondByte,
            thirdByte,
            fourthByte,
            tempCodePoint;
        switch (bytesPerSequence) {
          case 1:
            if (firstByte < 0x80) {
              codePoint = firstByte;
            }
            break;
          case 2:
            secondByte = buf[i + 1];
            if ((secondByte & 0xC0) === 0x80) {
              tempCodePoint = (firstByte & 0x1F) << 0x6 | (secondByte & 0x3F);
              if (tempCodePoint > 0x7F) {
                codePoint = tempCodePoint;
              }
            }
            break;
          case 3:
            secondByte = buf[i + 1];
            thirdByte = buf[i + 2];
            if ((secondByte & 0xC0) === 0x80 && (thirdByte & 0xC0) === 0x80) {
              tempCodePoint = (firstByte & 0xF) << 0xC | (secondByte & 0x3F) << 0x6 | (thirdByte & 0x3F);
              if (tempCodePoint > 0x7FF && (tempCodePoint < 0xD800 || tempCodePoint > 0xDFFF)) {
                codePoint = tempCodePoint;
              }
            }
            break;
          case 4:
            secondByte = buf[i + 1];
            thirdByte = buf[i + 2];
            fourthByte = buf[i + 3];
            if ((secondByte & 0xC0) === 0x80 && (thirdByte & 0xC0) === 0x80 && (fourthByte & 0xC0) === 0x80) {
              tempCodePoint = (firstByte & 0xF) << 0x12 | (secondByte & 0x3F) << 0xC | (thirdByte & 0x3F) << 0x6 | (fourthByte & 0x3F);
              if (tempCodePoint > 0xFFFF && tempCodePoint < 0x110000) {
                codePoint = tempCodePoint;
              }
            }
        }
      }
      if (codePoint === null) {
        codePoint = 0xFFFD;
        bytesPerSequence = 1;
      } else if (codePoint > 0xFFFF) {
        codePoint -= 0x10000;
        res.push(codePoint >>> 10 & 0x3FF | 0xD800);
        codePoint = 0xDC00 | codePoint & 0x3FF;
      }
      res.push(codePoint);
      i += bytesPerSequence;
    }
    return decodeCodePointsArray(res);
  }
  var MAX_ARGUMENTS_LENGTH = 0x1000;
  function decodeCodePointsArray(codePoints) {
    var len = codePoints.length;
    if (len <= MAX_ARGUMENTS_LENGTH) {
      return String.fromCharCode.apply(String, codePoints);
    }
    var res = '';
    var i = 0;
    while (i < len) {
      res += String.fromCharCode.apply(String, codePoints.slice(i, i += MAX_ARGUMENTS_LENGTH));
    }
    return res;
  }
  function asciiSlice(buf, start, end) {
    var ret = '';
    end = Math.min(buf.length, end);
    for (var i = start; i < end; i++) {
      ret += String.fromCharCode(buf[i] & 0x7F);
    }
    return ret;
  }
  function binarySlice(buf, start, end) {
    var ret = '';
    end = Math.min(buf.length, end);
    for (var i = start; i < end; i++) {
      ret += String.fromCharCode(buf[i]);
    }
    return ret;
  }
  function hexSlice(buf, start, end) {
    var len = buf.length;
    if (!start || start < 0)
      start = 0;
    if (!end || end < 0 || end > len)
      end = len;
    var out = '';
    for (var i = start; i < end; i++) {
      out += toHex(buf[i]);
    }
    return out;
  }
  function utf16leSlice(buf, start, end) {
    var bytes = buf.slice(start, end);
    var res = '';
    for (var i = 0; i < bytes.length; i += 2) {
      res += String.fromCharCode(bytes[i] + bytes[i + 1] * 256);
    }
    return res;
  }
  Buffer.prototype.slice = function slice(start, end) {
    var len = this.length;
    start = ~~start;
    end = end === undefined ? len : ~~end;
    if (start < 0) {
      start += len;
      if (start < 0)
        start = 0;
    } else if (start > len) {
      start = len;
    }
    if (end < 0) {
      end += len;
      if (end < 0)
        end = 0;
    } else if (end > len) {
      end = len;
    }
    if (end < start)
      end = start;
    var newBuf;
    if (Buffer.TYPED_ARRAY_SUPPORT) {
      newBuf = Buffer._augment(this.subarray(start, end));
    } else {
      var sliceLen = end - start;
      newBuf = new Buffer(sliceLen, undefined);
      for (var i = 0; i < sliceLen; i++) {
        newBuf[i] = this[i + start];
      }
    }
    if (newBuf.length)
      newBuf.parent = this.parent || this;
    return newBuf;
  };
  function checkOffset(offset, ext, length) {
    if ((offset % 1) !== 0 || offset < 0)
      throw new RangeError('offset is not uint');
    if (offset + ext > length)
      throw new RangeError('Trying to access beyond buffer length');
  }
  Buffer.prototype.readUIntLE = function readUIntLE(offset, byteLength, noAssert) {
    offset = offset | 0;
    byteLength = byteLength | 0;
    if (!noAssert)
      checkOffset(offset, byteLength, this.length);
    var val = this[offset];
    var mul = 1;
    var i = 0;
    while (++i < byteLength && (mul *= 0x100)) {
      val += this[offset + i] * mul;
    }
    return val;
  };
  Buffer.prototype.readUIntBE = function readUIntBE(offset, byteLength, noAssert) {
    offset = offset | 0;
    byteLength = byteLength | 0;
    if (!noAssert) {
      checkOffset(offset, byteLength, this.length);
    }
    var val = this[offset + --byteLength];
    var mul = 1;
    while (byteLength > 0 && (mul *= 0x100)) {
      val += this[offset + --byteLength] * mul;
    }
    return val;
  };
  Buffer.prototype.readUInt8 = function readUInt8(offset, noAssert) {
    if (!noAssert)
      checkOffset(offset, 1, this.length);
    return this[offset];
  };
  Buffer.prototype.readUInt16LE = function readUInt16LE(offset, noAssert) {
    if (!noAssert)
      checkOffset(offset, 2, this.length);
    return this[offset] | (this[offset + 1] << 8);
  };
  Buffer.prototype.readUInt16BE = function readUInt16BE(offset, noAssert) {
    if (!noAssert)
      checkOffset(offset, 2, this.length);
    return (this[offset] << 8) | this[offset + 1];
  };
  Buffer.prototype.readUInt32LE = function readUInt32LE(offset, noAssert) {
    if (!noAssert)
      checkOffset(offset, 4, this.length);
    return ((this[offset]) | (this[offset + 1] << 8) | (this[offset + 2] << 16)) + (this[offset + 3] * 0x1000000);
  };
  Buffer.prototype.readUInt32BE = function readUInt32BE(offset, noAssert) {
    if (!noAssert)
      checkOffset(offset, 4, this.length);
    return (this[offset] * 0x1000000) + ((this[offset + 1] << 16) | (this[offset + 2] << 8) | this[offset + 3]);
  };
  Buffer.prototype.readIntLE = function readIntLE(offset, byteLength, noAssert) {
    offset = offset | 0;
    byteLength = byteLength | 0;
    if (!noAssert)
      checkOffset(offset, byteLength, this.length);
    var val = this[offset];
    var mul = 1;
    var i = 0;
    while (++i < byteLength && (mul *= 0x100)) {
      val += this[offset + i] * mul;
    }
    mul *= 0x80;
    if (val >= mul)
      val -= Math.pow(2, 8 * byteLength);
    return val;
  };
  Buffer.prototype.readIntBE = function readIntBE(offset, byteLength, noAssert) {
    offset = offset | 0;
    byteLength = byteLength | 0;
    if (!noAssert)
      checkOffset(offset, byteLength, this.length);
    var i = byteLength;
    var mul = 1;
    var val = this[offset + --i];
    while (i > 0 && (mul *= 0x100)) {
      val += this[offset + --i] * mul;
    }
    mul *= 0x80;
    if (val >= mul)
      val -= Math.pow(2, 8 * byteLength);
    return val;
  };
  Buffer.prototype.readInt8 = function readInt8(offset, noAssert) {
    if (!noAssert)
      checkOffset(offset, 1, this.length);
    if (!(this[offset] & 0x80))
      return (this[offset]);
    return ((0xff - this[offset] + 1) * -1);
  };
  Buffer.prototype.readInt16LE = function readInt16LE(offset, noAssert) {
    if (!noAssert)
      checkOffset(offset, 2, this.length);
    var val = this[offset] | (this[offset + 1] << 8);
    return (val & 0x8000) ? val | 0xFFFF0000 : val;
  };
  Buffer.prototype.readInt16BE = function readInt16BE(offset, noAssert) {
    if (!noAssert)
      checkOffset(offset, 2, this.length);
    var val = this[offset + 1] | (this[offset] << 8);
    return (val & 0x8000) ? val | 0xFFFF0000 : val;
  };
  Buffer.prototype.readInt32LE = function readInt32LE(offset, noAssert) {
    if (!noAssert)
      checkOffset(offset, 4, this.length);
    return (this[offset]) | (this[offset + 1] << 8) | (this[offset + 2] << 16) | (this[offset + 3] << 24);
  };
  Buffer.prototype.readInt32BE = function readInt32BE(offset, noAssert) {
    if (!noAssert)
      checkOffset(offset, 4, this.length);
    return (this[offset] << 24) | (this[offset + 1] << 16) | (this[offset + 2] << 8) | (this[offset + 3]);
  };
  Buffer.prototype.readFloatLE = function readFloatLE(offset, noAssert) {
    if (!noAssert)
      checkOffset(offset, 4, this.length);
    return ieee754.read(this, offset, true, 23, 4);
  };
  Buffer.prototype.readFloatBE = function readFloatBE(offset, noAssert) {
    if (!noAssert)
      checkOffset(offset, 4, this.length);
    return ieee754.read(this, offset, false, 23, 4);
  };
  Buffer.prototype.readDoubleLE = function readDoubleLE(offset, noAssert) {
    if (!noAssert)
      checkOffset(offset, 8, this.length);
    return ieee754.read(this, offset, true, 52, 8);
  };
  Buffer.prototype.readDoubleBE = function readDoubleBE(offset, noAssert) {
    if (!noAssert)
      checkOffset(offset, 8, this.length);
    return ieee754.read(this, offset, false, 52, 8);
  };
  function checkInt(buf, value, offset, ext, max, min) {
    if (!Buffer.isBuffer(buf))
      throw new TypeError('buffer must be a Buffer instance');
    if (value > max || value < min)
      throw new RangeError('value is out of bounds');
    if (offset + ext > buf.length)
      throw new RangeError('index out of range');
  }
  Buffer.prototype.writeUIntLE = function writeUIntLE(value, offset, byteLength, noAssert) {
    value = +value;
    offset = offset | 0;
    byteLength = byteLength | 0;
    if (!noAssert)
      checkInt(this, value, offset, byteLength, Math.pow(2, 8 * byteLength), 0);
    var mul = 1;
    var i = 0;
    this[offset] = value & 0xFF;
    while (++i < byteLength && (mul *= 0x100)) {
      this[offset + i] = (value / mul) & 0xFF;
    }
    return offset + byteLength;
  };
  Buffer.prototype.writeUIntBE = function writeUIntBE(value, offset, byteLength, noAssert) {
    value = +value;
    offset = offset | 0;
    byteLength = byteLength | 0;
    if (!noAssert)
      checkInt(this, value, offset, byteLength, Math.pow(2, 8 * byteLength), 0);
    var i = byteLength - 1;
    var mul = 1;
    this[offset + i] = value & 0xFF;
    while (--i >= 0 && (mul *= 0x100)) {
      this[offset + i] = (value / mul) & 0xFF;
    }
    return offset + byteLength;
  };
  Buffer.prototype.writeUInt8 = function writeUInt8(value, offset, noAssert) {
    value = +value;
    offset = offset | 0;
    if (!noAssert)
      checkInt(this, value, offset, 1, 0xff, 0);
    if (!Buffer.TYPED_ARRAY_SUPPORT)
      value = Math.floor(value);
    this[offset] = value;
    return offset + 1;
  };
  function objectWriteUInt16(buf, value, offset, littleEndian) {
    if (value < 0)
      value = 0xffff + value + 1;
    for (var i = 0,
        j = Math.min(buf.length - offset, 2); i < j; i++) {
      buf[offset + i] = (value & (0xff << (8 * (littleEndian ? i : 1 - i)))) >>> (littleEndian ? i : 1 - i) * 8;
    }
  }
  Buffer.prototype.writeUInt16LE = function writeUInt16LE(value, offset, noAssert) {
    value = +value;
    offset = offset | 0;
    if (!noAssert)
      checkInt(this, value, offset, 2, 0xffff, 0);
    if (Buffer.TYPED_ARRAY_SUPPORT) {
      this[offset] = value;
      this[offset + 1] = (value >>> 8);
    } else {
      objectWriteUInt16(this, value, offset, true);
    }
    return offset + 2;
  };
  Buffer.prototype.writeUInt16BE = function writeUInt16BE(value, offset, noAssert) {
    value = +value;
    offset = offset | 0;
    if (!noAssert)
      checkInt(this, value, offset, 2, 0xffff, 0);
    if (Buffer.TYPED_ARRAY_SUPPORT) {
      this[offset] = (value >>> 8);
      this[offset + 1] = value;
    } else {
      objectWriteUInt16(this, value, offset, false);
    }
    return offset + 2;
  };
  function objectWriteUInt32(buf, value, offset, littleEndian) {
    if (value < 0)
      value = 0xffffffff + value + 1;
    for (var i = 0,
        j = Math.min(buf.length - offset, 4); i < j; i++) {
      buf[offset + i] = (value >>> (littleEndian ? i : 3 - i) * 8) & 0xff;
    }
  }
  Buffer.prototype.writeUInt32LE = function writeUInt32LE(value, offset, noAssert) {
    value = +value;
    offset = offset | 0;
    if (!noAssert)
      checkInt(this, value, offset, 4, 0xffffffff, 0);
    if (Buffer.TYPED_ARRAY_SUPPORT) {
      this[offset + 3] = (value >>> 24);
      this[offset + 2] = (value >>> 16);
      this[offset + 1] = (value >>> 8);
      this[offset] = value;
    } else {
      objectWriteUInt32(this, value, offset, true);
    }
    return offset + 4;
  };
  Buffer.prototype.writeUInt32BE = function writeUInt32BE(value, offset, noAssert) {
    value = +value;
    offset = offset | 0;
    if (!noAssert)
      checkInt(this, value, offset, 4, 0xffffffff, 0);
    if (Buffer.TYPED_ARRAY_SUPPORT) {
      this[offset] = (value >>> 24);
      this[offset + 1] = (value >>> 16);
      this[offset + 2] = (value >>> 8);
      this[offset + 3] = value;
    } else {
      objectWriteUInt32(this, value, offset, false);
    }
    return offset + 4;
  };
  Buffer.prototype.writeIntLE = function writeIntLE(value, offset, byteLength, noAssert) {
    value = +value;
    offset = offset | 0;
    if (!noAssert) {
      var limit = Math.pow(2, 8 * byteLength - 1);
      checkInt(this, value, offset, byteLength, limit - 1, -limit);
    }
    var i = 0;
    var mul = 1;
    var sub = value < 0 ? 1 : 0;
    this[offset] = value & 0xFF;
    while (++i < byteLength && (mul *= 0x100)) {
      this[offset + i] = ((value / mul) >> 0) - sub & 0xFF;
    }
    return offset + byteLength;
  };
  Buffer.prototype.writeIntBE = function writeIntBE(value, offset, byteLength, noAssert) {
    value = +value;
    offset = offset | 0;
    if (!noAssert) {
      var limit = Math.pow(2, 8 * byteLength - 1);
      checkInt(this, value, offset, byteLength, limit - 1, -limit);
    }
    var i = byteLength - 1;
    var mul = 1;
    var sub = value < 0 ? 1 : 0;
    this[offset + i] = value & 0xFF;
    while (--i >= 0 && (mul *= 0x100)) {
      this[offset + i] = ((value / mul) >> 0) - sub & 0xFF;
    }
    return offset + byteLength;
  };
  Buffer.prototype.writeInt8 = function writeInt8(value, offset, noAssert) {
    value = +value;
    offset = offset | 0;
    if (!noAssert)
      checkInt(this, value, offset, 1, 0x7f, -0x80);
    if (!Buffer.TYPED_ARRAY_SUPPORT)
      value = Math.floor(value);
    if (value < 0)
      value = 0xff + value + 1;
    this[offset] = value;
    return offset + 1;
  };
  Buffer.prototype.writeInt16LE = function writeInt16LE(value, offset, noAssert) {
    value = +value;
    offset = offset | 0;
    if (!noAssert)
      checkInt(this, value, offset, 2, 0x7fff, -0x8000);
    if (Buffer.TYPED_ARRAY_SUPPORT) {
      this[offset] = value;
      this[offset + 1] = (value >>> 8);
    } else {
      objectWriteUInt16(this, value, offset, true);
    }
    return offset + 2;
  };
  Buffer.prototype.writeInt16BE = function writeInt16BE(value, offset, noAssert) {
    value = +value;
    offset = offset | 0;
    if (!noAssert)
      checkInt(this, value, offset, 2, 0x7fff, -0x8000);
    if (Buffer.TYPED_ARRAY_SUPPORT) {
      this[offset] = (value >>> 8);
      this[offset + 1] = value;
    } else {
      objectWriteUInt16(this, value, offset, false);
    }
    return offset + 2;
  };
  Buffer.prototype.writeInt32LE = function writeInt32LE(value, offset, noAssert) {
    value = +value;
    offset = offset | 0;
    if (!noAssert)
      checkInt(this, value, offset, 4, 0x7fffffff, -0x80000000);
    if (Buffer.TYPED_ARRAY_SUPPORT) {
      this[offset] = value;
      this[offset + 1] = (value >>> 8);
      this[offset + 2] = (value >>> 16);
      this[offset + 3] = (value >>> 24);
    } else {
      objectWriteUInt32(this, value, offset, true);
    }
    return offset + 4;
  };
  Buffer.prototype.writeInt32BE = function writeInt32BE(value, offset, noAssert) {
    value = +value;
    offset = offset | 0;
    if (!noAssert)
      checkInt(this, value, offset, 4, 0x7fffffff, -0x80000000);
    if (value < 0)
      value = 0xffffffff + value + 1;
    if (Buffer.TYPED_ARRAY_SUPPORT) {
      this[offset] = (value >>> 24);
      this[offset + 1] = (value >>> 16);
      this[offset + 2] = (value >>> 8);
      this[offset + 3] = value;
    } else {
      objectWriteUInt32(this, value, offset, false);
    }
    return offset + 4;
  };
  function checkIEEE754(buf, value, offset, ext, max, min) {
    if (value > max || value < min)
      throw new RangeError('value is out of bounds');
    if (offset + ext > buf.length)
      throw new RangeError('index out of range');
    if (offset < 0)
      throw new RangeError('index out of range');
  }
  function writeFloat(buf, value, offset, littleEndian, noAssert) {
    if (!noAssert) {
      checkIEEE754(buf, value, offset, 4, 3.4028234663852886e+38, -3.4028234663852886e+38);
    }
    ieee754.write(buf, value, offset, littleEndian, 23, 4);
    return offset + 4;
  }
  Buffer.prototype.writeFloatLE = function writeFloatLE(value, offset, noAssert) {
    return writeFloat(this, value, offset, true, noAssert);
  };
  Buffer.prototype.writeFloatBE = function writeFloatBE(value, offset, noAssert) {
    return writeFloat(this, value, offset, false, noAssert);
  };
  function writeDouble(buf, value, offset, littleEndian, noAssert) {
    if (!noAssert) {
      checkIEEE754(buf, value, offset, 8, 1.7976931348623157E+308, -1.7976931348623157E+308);
    }
    ieee754.write(buf, value, offset, littleEndian, 52, 8);
    return offset + 8;
  }
  Buffer.prototype.writeDoubleLE = function writeDoubleLE(value, offset, noAssert) {
    return writeDouble(this, value, offset, true, noAssert);
  };
  Buffer.prototype.writeDoubleBE = function writeDoubleBE(value, offset, noAssert) {
    return writeDouble(this, value, offset, false, noAssert);
  };
  Buffer.prototype.copy = function copy(target, targetStart, start, end) {
    if (!start)
      start = 0;
    if (!end && end !== 0)
      end = this.length;
    if (targetStart >= target.length)
      targetStart = target.length;
    if (!targetStart)
      targetStart = 0;
    if (end > 0 && end < start)
      end = start;
    if (end === start)
      return 0;
    if (target.length === 0 || this.length === 0)
      return 0;
    if (targetStart < 0) {
      throw new RangeError('targetStart out of bounds');
    }
    if (start < 0 || start >= this.length)
      throw new RangeError('sourceStart out of bounds');
    if (end < 0)
      throw new RangeError('sourceEnd out of bounds');
    if (end > this.length)
      end = this.length;
    if (target.length - targetStart < end - start) {
      end = target.length - targetStart + start;
    }
    var len = end - start;
    var i;
    if (this === target && start < targetStart && targetStart < end) {
      for (i = len - 1; i >= 0; i--) {
        target[i + targetStart] = this[i + start];
      }
    } else if (len < 1000 || !Buffer.TYPED_ARRAY_SUPPORT) {
      for (i = 0; i < len; i++) {
        target[i + targetStart] = this[i + start];
      }
    } else {
      target._set(this.subarray(start, start + len), targetStart);
    }
    return len;
  };
  Buffer.prototype.fill = function fill(value, start, end) {
    if (!value)
      value = 0;
    if (!start)
      start = 0;
    if (!end)
      end = this.length;
    if (end < start)
      throw new RangeError('end < start');
    if (end === start)
      return;
    if (this.length === 0)
      return;
    if (start < 0 || start >= this.length)
      throw new RangeError('start out of bounds');
    if (end < 0 || end > this.length)
      throw new RangeError('end out of bounds');
    var i;
    if (typeof value === 'number') {
      for (i = start; i < end; i++) {
        this[i] = value;
      }
    } else {
      var bytes = utf8ToBytes(value.toString());
      var len = bytes.length;
      for (i = start; i < end; i++) {
        this[i] = bytes[i % len];
      }
    }
    return this;
  };
  Buffer.prototype.toArrayBuffer = function toArrayBuffer() {
    if (typeof Uint8Array !== 'undefined') {
      if (Buffer.TYPED_ARRAY_SUPPORT) {
        return (new Buffer(this)).buffer;
      } else {
        var buf = new Uint8Array(this.length);
        for (var i = 0,
            len = buf.length; i < len; i += 1) {
          buf[i] = this[i];
        }
        return buf.buffer;
      }
    } else {
      throw new TypeError('Buffer.toArrayBuffer not supported in this browser');
    }
  };
  var BP = Buffer.prototype;
  Buffer._augment = function _augment(arr) {
    arr.constructor = Buffer;
    arr._isBuffer = true;
    arr._set = arr.set;
    arr.get = BP.get;
    arr.set = BP.set;
    arr.write = BP.write;
    arr.toString = BP.toString;
    arr.toLocaleString = BP.toString;
    arr.toJSON = BP.toJSON;
    arr.equals = BP.equals;
    arr.compare = BP.compare;
    arr.indexOf = BP.indexOf;
    arr.copy = BP.copy;
    arr.slice = BP.slice;
    arr.readUIntLE = BP.readUIntLE;
    arr.readUIntBE = BP.readUIntBE;
    arr.readUInt8 = BP.readUInt8;
    arr.readUInt16LE = BP.readUInt16LE;
    arr.readUInt16BE = BP.readUInt16BE;
    arr.readUInt32LE = BP.readUInt32LE;
    arr.readUInt32BE = BP.readUInt32BE;
    arr.readIntLE = BP.readIntLE;
    arr.readIntBE = BP.readIntBE;
    arr.readInt8 = BP.readInt8;
    arr.readInt16LE = BP.readInt16LE;
    arr.readInt16BE = BP.readInt16BE;
    arr.readInt32LE = BP.readInt32LE;
    arr.readInt32BE = BP.readInt32BE;
    arr.readFloatLE = BP.readFloatLE;
    arr.readFloatBE = BP.readFloatBE;
    arr.readDoubleLE = BP.readDoubleLE;
    arr.readDoubleBE = BP.readDoubleBE;
    arr.writeUInt8 = BP.writeUInt8;
    arr.writeUIntLE = BP.writeUIntLE;
    arr.writeUIntBE = BP.writeUIntBE;
    arr.writeUInt16LE = BP.writeUInt16LE;
    arr.writeUInt16BE = BP.writeUInt16BE;
    arr.writeUInt32LE = BP.writeUInt32LE;
    arr.writeUInt32BE = BP.writeUInt32BE;
    arr.writeIntLE = BP.writeIntLE;
    arr.writeIntBE = BP.writeIntBE;
    arr.writeInt8 = BP.writeInt8;
    arr.writeInt16LE = BP.writeInt16LE;
    arr.writeInt16BE = BP.writeInt16BE;
    arr.writeInt32LE = BP.writeInt32LE;
    arr.writeInt32BE = BP.writeInt32BE;
    arr.writeFloatLE = BP.writeFloatLE;
    arr.writeFloatBE = BP.writeFloatBE;
    arr.writeDoubleLE = BP.writeDoubleLE;
    arr.writeDoubleBE = BP.writeDoubleBE;
    arr.fill = BP.fill;
    arr.inspect = BP.inspect;
    arr.toArrayBuffer = BP.toArrayBuffer;
    return arr;
  };
  var INVALID_BASE64_RE = /[^+\/0-9A-Za-z-_]/g;
  function base64clean(str) {
    str = stringtrim(str).replace(INVALID_BASE64_RE, '');
    if (str.length < 2)
      return '';
    while (str.length % 4 !== 0) {
      str = str + '=';
    }
    return str;
  }
  function stringtrim(str) {
    if (str.trim)
      return str.trim();
    return str.replace(/^\s+|\s+$/g, '');
  }
  function toHex(n) {
    if (n < 16)
      return '0' + n.toString(16);
    return n.toString(16);
  }
  function utf8ToBytes(string, units) {
    units = units || Infinity;
    var codePoint;
    var length = string.length;
    var leadSurrogate = null;
    var bytes = [];
    for (var i = 0; i < length; i++) {
      codePoint = string.charCodeAt(i);
      if (codePoint > 0xD7FF && codePoint < 0xE000) {
        if (!leadSurrogate) {
          if (codePoint > 0xDBFF) {
            if ((units -= 3) > -1)
              bytes.push(0xEF, 0xBF, 0xBD);
            continue;
          } else if (i + 1 === length) {
            if ((units -= 3) > -1)
              bytes.push(0xEF, 0xBF, 0xBD);
            continue;
          }
          leadSurrogate = codePoint;
          continue;
        }
        if (codePoint < 0xDC00) {
          if ((units -= 3) > -1)
            bytes.push(0xEF, 0xBF, 0xBD);
          leadSurrogate = codePoint;
          continue;
        }
        codePoint = leadSurrogate - 0xD800 << 10 | codePoint - 0xDC00 | 0x10000;
      } else if (leadSurrogate) {
        if ((units -= 3) > -1)
          bytes.push(0xEF, 0xBF, 0xBD);
      }
      leadSurrogate = null;
      if (codePoint < 0x80) {
        if ((units -= 1) < 0)
          break;
        bytes.push(codePoint);
      } else if (codePoint < 0x800) {
        if ((units -= 2) < 0)
          break;
        bytes.push(codePoint >> 0x6 | 0xC0, codePoint & 0x3F | 0x80);
      } else if (codePoint < 0x10000) {
        if ((units -= 3) < 0)
          break;
        bytes.push(codePoint >> 0xC | 0xE0, codePoint >> 0x6 & 0x3F | 0x80, codePoint & 0x3F | 0x80);
      } else if (codePoint < 0x110000) {
        if ((units -= 4) < 0)
          break;
        bytes.push(codePoint >> 0x12 | 0xF0, codePoint >> 0xC & 0x3F | 0x80, codePoint >> 0x6 & 0x3F | 0x80, codePoint & 0x3F | 0x80);
      } else {
        throw new Error('Invalid code point');
      }
    }
    return bytes;
  }
  function asciiToBytes(str) {
    var byteArray = [];
    for (var i = 0; i < str.length; i++) {
      byteArray.push(str.charCodeAt(i) & 0xFF);
    }
    return byteArray;
  }
  function utf16leToBytes(str, units) {
    var c,
        hi,
        lo;
    var byteArray = [];
    for (var i = 0; i < str.length; i++) {
      if ((units -= 2) < 0)
        break;
      c = str.charCodeAt(i);
      hi = c >> 8;
      lo = c % 256;
      byteArray.push(lo);
      byteArray.push(hi);
    }
    return byteArray;
  }
  function base64ToBytes(str) {
    return base64.toByteArray(base64clean(str));
  }
  function blitBuffer(src, dst, offset, length) {
    for (var i = 0; i < length; i++) {
      if ((i + offset >= dst.length) || (i >= src.length))
        break;
      dst[i + offset] = src[i];
    }
    return i;
  }
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("93", ["94"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  module.exports = require("94");
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("92", ["95"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  module.exports = require("95");
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("91", ["96"], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  module.exports = require("96");
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("95", [], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  exports.read = function(buffer, offset, isLE, mLen, nBytes) {
    var e,
        m;
    var eLen = nBytes * 8 - mLen - 1;
    var eMax = (1 << eLen) - 1;
    var eBias = eMax >> 1;
    var nBits = -7;
    var i = isLE ? (nBytes - 1) : 0;
    var d = isLE ? -1 : 1;
    var s = buffer[offset + i];
    i += d;
    e = s & ((1 << (-nBits)) - 1);
    s >>= (-nBits);
    nBits += eLen;
    for (; nBits > 0; e = e * 256 + buffer[offset + i], i += d, nBits -= 8) {}
    m = e & ((1 << (-nBits)) - 1);
    e >>= (-nBits);
    nBits += mLen;
    for (; nBits > 0; m = m * 256 + buffer[offset + i], i += d, nBits -= 8) {}
    if (e === 0) {
      e = 1 - eBias;
    } else if (e === eMax) {
      return m ? NaN : ((s ? -1 : 1) * Infinity);
    } else {
      m = m + Math.pow(2, mLen);
      e = e - eBias;
    }
    return (s ? -1 : 1) * m * Math.pow(2, e - mLen);
  };
  exports.write = function(buffer, value, offset, isLE, mLen, nBytes) {
    var e,
        m,
        c;
    var eLen = nBytes * 8 - mLen - 1;
    var eMax = (1 << eLen) - 1;
    var eBias = eMax >> 1;
    var rt = (mLen === 23 ? Math.pow(2, -24) - Math.pow(2, -77) : 0);
    var i = isLE ? 0 : (nBytes - 1);
    var d = isLE ? 1 : -1;
    var s = value < 0 || (value === 0 && 1 / value < 0) ? 1 : 0;
    value = Math.abs(value);
    if (isNaN(value) || value === Infinity) {
      m = isNaN(value) ? 1 : 0;
      e = eMax;
    } else {
      e = Math.floor(Math.log(value) / Math.LN2);
      if (value * (c = Math.pow(2, -e)) < 1) {
        e--;
        c *= 2;
      }
      if (e + eBias >= 1) {
        value += rt / c;
      } else {
        value += rt * Math.pow(2, 1 - eBias);
      }
      if (value * c >= 2) {
        e++;
        c /= 2;
      }
      if (e + eBias >= eMax) {
        m = 0;
        e = eMax;
      } else if (e + eBias >= 1) {
        m = (value * c - 1) * Math.pow(2, mLen);
        e = e + eBias;
      } else {
        m = value * Math.pow(2, eBias - 1) * Math.pow(2, mLen);
        e = 0;
      }
    }
    for (; mLen >= 8; buffer[offset + i] = m & 0xff, i += d, m /= 256, mLen -= 8) {}
    e = (e << mLen) | m;
    eLen += mLen;
    for (; eLen > 0; buffer[offset + i] = e & 0xff, i += d, e /= 256, eLen -= 8) {}
    buffer[offset + i - d] |= s * 128;
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("94", [], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var isArray = Array.isArray;
  var str = Object.prototype.toString;
  module.exports = isArray || function(val) {
    return !!val && '[object Array]' == str.call(val);
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("96", [], true, function(require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var lookup = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  ;
  (function(exports) {
    'use strict';
    var Arr = (typeof Uint8Array !== 'undefined') ? Uint8Array : Array;
    var PLUS = '+'.charCodeAt(0);
    var SLASH = '/'.charCodeAt(0);
    var NUMBER = '0'.charCodeAt(0);
    var LOWER = 'a'.charCodeAt(0);
    var UPPER = 'A'.charCodeAt(0);
    var PLUS_URL_SAFE = '-'.charCodeAt(0);
    var SLASH_URL_SAFE = '_'.charCodeAt(0);
    function decode(elt) {
      var code = elt.charCodeAt(0);
      if (code === PLUS || code === PLUS_URL_SAFE)
        return 62;
      if (code === SLASH || code === SLASH_URL_SAFE)
        return 63;
      if (code < NUMBER)
        return -1;
      if (code < NUMBER + 10)
        return code - NUMBER + 26 + 26;
      if (code < UPPER + 26)
        return code - UPPER;
      if (code < LOWER + 26)
        return code - LOWER + 26;
    }
    function b64ToByteArray(b64) {
      var i,
          j,
          l,
          tmp,
          placeHolders,
          arr;
      if (b64.length % 4 > 0) {
        throw new Error('Invalid string. Length must be a multiple of 4');
      }
      var len = b64.length;
      placeHolders = '=' === b64.charAt(len - 2) ? 2 : '=' === b64.charAt(len - 1) ? 1 : 0;
      arr = new Arr(b64.length * 3 / 4 - placeHolders);
      l = placeHolders > 0 ? b64.length - 4 : b64.length;
      var L = 0;
      function push(v) {
        arr[L++] = v;
      }
      for (i = 0, j = 0; i < l; i += 4, j += 3) {
        tmp = (decode(b64.charAt(i)) << 18) | (decode(b64.charAt(i + 1)) << 12) | (decode(b64.charAt(i + 2)) << 6) | decode(b64.charAt(i + 3));
        push((tmp & 0xFF0000) >> 16);
        push((tmp & 0xFF00) >> 8);
        push(tmp & 0xFF);
      }
      if (placeHolders === 2) {
        tmp = (decode(b64.charAt(i)) << 2) | (decode(b64.charAt(i + 1)) >> 4);
        push(tmp & 0xFF);
      } else if (placeHolders === 1) {
        tmp = (decode(b64.charAt(i)) << 10) | (decode(b64.charAt(i + 1)) << 4) | (decode(b64.charAt(i + 2)) >> 2);
        push((tmp >> 8) & 0xFF);
        push(tmp & 0xFF);
      }
      return arr;
    }
    function uint8ToBase64(uint8) {
      var i,
          extraBytes = uint8.length % 3,
          output = "",
          temp,
          length;
      function encode(num) {
        return lookup.charAt(num);
      }
      function tripletToBase64(num) {
        return encode(num >> 18 & 0x3F) + encode(num >> 12 & 0x3F) + encode(num >> 6 & 0x3F) + encode(num & 0x3F);
      }
      for (i = 0, length = uint8.length - extraBytes; i < length; i += 3) {
        temp = (uint8[i] << 16) + (uint8[i + 1] << 8) + (uint8[i + 2]);
        output += tripletToBase64(temp);
      }
      switch (extraBytes) {
        case 1:
          temp = uint8[uint8.length - 1];
          output += encode(temp >> 2);
          output += encode((temp << 4) & 0x3F);
          output += '==';
          break;
        case 2:
          temp = (uint8[uint8.length - 2] << 8) + (uint8[uint8.length - 1]);
          output += encode(temp >> 10);
          output += encode((temp >> 4) & 0x3F);
          output += encode((temp << 2) & 0x3F);
          output += '=';
          break;
      }
      return output;
    }
    exports.toByteArray = b64ToByteArray;
    exports.fromByteArray = uint8ToBase64;
  }(typeof exports === 'undefined' ? (this.base64js = {}) : exports));
  global.define = __define;
  return module.exports;
});

$__System.register('0', ['1', '4', '5', '6', '7', '8', '9', 'a', 'b', 'c', 'd', 'e'], function (_export) {
  'use strict';

  // Injects all classes etc. into leaflet's global L object.
  // This is the "classic" non-ES6-module interface.

  var L, LayerFactory, Legend, DiscreteLegend, TimeAxis, VerticalAxis, Grid, Profile, Trajectory, palettes, ParameterSync, ProfilePlot, c, _arr, _i, ns;

  return {
    setters: [function (_) {
      L = _['default'];
    }, function (_2) {
      LayerFactory = _2['default'];
    }, function (_3) {
      Legend = _3['default'];
    }, function (_4) {
      DiscreteLegend = _4['default'];
    }, function (_5) {
      TimeAxis = _5['default'];
    }, function (_6) {
      VerticalAxis = _6['default'];
    }, function (_7) {
      Grid = _7['default'];
    }, function (_a) {
      Profile = _a['default'];
    }, function (_b) {
      Trajectory = _b['default'];
    }, function (_c) {
      palettes = _c;
    }, function (_d) {
      ParameterSync = _d['default'];
    }, function (_e) {
      ProfilePlot = _e['default'];
    }],
    execute: function () {

      if (!('Coverage' in L)) {
        L.coverage = {};
      }

      c = L.coverage;
      _arr = ['control', 'renderer', 'popup', 'palette'];

      for (_i = 0; _i < _arr.length; _i++) {
        ns = _arr[_i];

        if (!(ns in c)) {
          c[ns] = {};
        }
      }

      c.LayerFactory = LayerFactory;
      c.ParameterSync = ParameterSync;
      c.control.Legend = Legend;
      c.control.DiscreteLegend = DiscreteLegend;
      c.control.TimeAxis = TimeAxis;
      c.control.VerticalAxis = VerticalAxis;
      c.renderer.Grid = Grid;
      c.renderer.Profile = Profile;
      c.renderer.Trajectory = Trajectory;
      c.popup.ProfilePlot = ProfilePlot;
      c.palette = palettes;
    }
  };
});

$__System.register('5', ['1', '10', '11', '12', '13', '14', '15', '16', 'f'], function (_export) {
  var L, inject, i18n, _get, _inherits, _createClass, _classCallCheck, _slicedToArray, $, DEFAULT_TEMPLATE_ID, DEFAULT_TEMPLATE, DEFAULT_TEMPLATE_CSS, Legend;

  return {
    setters: [function (_6) {
      L = _6['default'];
    }, function (_7) {
      inject = _7.inject;
    }, function (_8) {
      i18n = _8;
    }, function (_) {
      _get = _['default'];
    }, function (_2) {
      _inherits = _2['default'];
    }, function (_3) {
      _createClass = _3['default'];
    }, function (_4) {
      _classCallCheck = _4['default'];
    }, function (_5) {
      _slicedToArray = _5['default'];
    }, function (_f) {
      $ = _f.$;
    }],
    execute: function () {

      // TODO the default template should be moved outside this module so that it can be easily skipped
      'use strict';

      DEFAULT_TEMPLATE_ID = 'template-coverage-parameter-legend';
      DEFAULT_TEMPLATE = '\n<template id="' + DEFAULT_TEMPLATE_ID + '">\n  <div class="info legend continuous-legend">\n    <div style="margin-bottom:3px">\n      <strong class="legend-title"></strong>\n    </div>\n    <div style="display: inline-block; height: 144px; float:left">\n      <span style="height: 136px; width: 18px; display: block; margin-top: 9px;" class="legend-palette"></span>\n    </div>\n    <div style="display: inline-block; float:left; height:153px">\n      <table style="height: 100%;">\n        <tr><td style="vertical-align:top"><span class="legend-max"></span> <span class="legend-uom"></span></td></tr>\n        <tr><td><span class="legend-current"></span></td></tr>\n        <tr><td style="vertical-align:bottom"><span class="legend-min"></span> <span class="legend-uom"></span></td></tr>\n      </table>\n    </div>\n  </div>\n</template>\n';
      DEFAULT_TEMPLATE_CSS = '\n.legend {\n  color: #555;\n}\n';

      /**
       * Displays a palette legend for the parameter displayed by the given
       * Coverage layer.
       */

      Legend = (function (_L$Control) {
        _inherits(Legend, _L$Control);

        function Legend(covLayer, options) {
          _classCallCheck(this, Legend);

          _get(Object.getPrototypeOf(Legend.prototype), 'constructor', this).call(this, options.position ? { position: options.position } : {});
          this.covLayer = covLayer;
          this.id = options.id || DEFAULT_TEMPLATE_ID;
          this.language = options.language || i18n.DEFAULT_LANGUAGE;

          if (!options.id && document.getElementById(DEFAULT_TEMPLATE_ID) === null) {
            inject(DEFAULT_TEMPLATE, DEFAULT_TEMPLATE_CSS);
          }

          // arrow function is broken here with traceur, this is a workaround
          // see https://github.com/google/traceur-compiler/issues/1987
          var self = this;
          this._remove = function () {
            self.removeFrom(self._map);
          };
          covLayer.on('remove', this._remove);
        }

        _createClass(Legend, [{
          key: 'updateLegend',
          value: function updateLegend() {
            var el = this._el;

            var palette = this.covLayer.palette;

            var _covLayer$paletteExtent = _slicedToArray(this.covLayer.paletteExtent, 2);

            var low = _covLayer$paletteExtent[0];
            var high = _covLayer$paletteExtent[1];

            $('.legend-min', el).fill(low.toFixed(2));
            $('.legend-max', el).fill(high.toFixed(2));

            var gradient = '';
            for (var i = 0; i < palette.steps; i++) {
              if (i > 0) gradient += ',';
              gradient += 'rgb(' + palette.red[i] + ',' + palette.green[i] + ',' + palette.blue[i] + ')';
            }

            $('.legend-palette', el).set('$background', 'transparent linear-gradient(to top, ' + gradient + ') repeat scroll 0% 0%');
          }
        }, {
          key: 'onRemove',
          value: function onRemove(map) {
            var _this = this;

            this.covLayer.off('remove', this._remove);
            this.covLayer.off('paletteChange', function () {
              return _this.updateLegend();
            });
            this.covLayer.off('paletteExtentChange', function () {
              return _this.updateLegend();
            });
          }
        }, {
          key: 'onAdd',
          value: function onAdd(map) {
            var _this2 = this;

            this._map = map;

            this.covLayer.on('paletteChange', function () {
              return _this2.updateLegend();
            });
            this.covLayer.on('paletteExtentChange', function () {
              return _this2.updateLegend();
            });

            var param = this.covLayer.parameter;
            // if requested language doesn't exist, use the returned one for all other labels
            var language = i18n.getLanguageTag(param.observedProperty.label, this.language);
            var title = i18n.getLanguageString(param.observedProperty.label, language);
            var unit = param.unit ? param.unit.symbol ? param.unit.symbol : i18n.getLanguageString(param.unit.label, language) : '';

            var el = document.importNode($('#' + this.id)[0].content, true).children[0];
            this._el = el;
            $('.legend-title', el).fill(title);
            $('.legend-uom', el).fill(unit);
            this.updateLegend();

            return el;
          }
        }]);

        return Legend;
      })(L.Control);

      _export('default', Legend);
    }
  };
});

$__System.register('4', ['9', '17', '18', 'b', 'a'], function (_export) {
  var Grid, _defineProperty, _Object$keys, Trajectory, Profile, _DEFAULT_RENDERERS, pre, DEFAULT_RENDERERS;

  function LayerFactory() {
    var options = arguments.length <= 0 || arguments[0] === undefined ? {} : arguments[0];

    if (options.renderer) {
      return function (cov, opts) {
        return new options.renderer(cov, opts);
      };
    }
    if (options.renderers) {
      return function (cov, opts) {
        if (options.renderers[cov.type]) {
          return new options.renderers[cov.type](cov, opts);
        }
        if (options.renderers[cov.domainType]) {
          return new options.renderers[cov.domainType](cov, opts);
        }
        throw new Error('No renderer found for type=' + cov.type + ' or domainType=' + cov.domainType + ',\n                       available: ' + _Object$keys(options.renderers));
      };
    }
    return function (cov, opts) {
      if (!DEFAULT_RENDERERS[cov.domainType]) {
        throw new Error('No renderer found for domainType=' + cov.domainType + ',\n          available: ' + _Object$keys(DEFAULT_RENDERERS));
      }
      return new DEFAULT_RENDERERS[cov.domainType](cov, opts);
    };
  }

  return {
    setters: [function (_3) {
      Grid = _3['default'];
    }, function (_) {
      _defineProperty = _['default'];
    }, function (_2) {
      _Object$keys = _2['default'];
    }, function (_b) {
      Trajectory = _b['default'];
    }, function (_a) {
      Profile = _a['default'];
    }],
    execute: function () {
      'use strict';

      _export('default', LayerFactory);

      pre = 'http://coveragejson.org/def#';
      DEFAULT_RENDERERS = (_DEFAULT_RENDERERS = {}, _defineProperty(_DEFAULT_RENDERERS, pre + 'Grid', Grid), _defineProperty(_DEFAULT_RENDERERS, pre + 'Profile', Profile), _defineProperty(_DEFAULT_RENDERERS, pre + 'Trajectory', Trajectory), _DEFAULT_RENDERERS);

      _export('DEFAULT_RENDERERS', DEFAULT_RENDERERS);
    }
  };
});

$__System.register('6', ['1', '10', '11', '12', '13', '14', '15', 'f'], function (_export) {
  var L, inject, i18n, _get, _inherits, _createClass, _classCallCheck, $, HTML, DEFAULT_TEMPLATE_ID, DEFAULT_TEMPLATE, DEFAULT_TEMPLATE_CSS, DiscreteLegend;

  return {
    setters: [function (_5) {
      L = _5['default'];
    }, function (_6) {
      inject = _6.inject;
    }, function (_7) {
      i18n = _7;
    }, function (_) {
      _get = _['default'];
    }, function (_2) {
      _inherits = _2['default'];
    }, function (_3) {
      _createClass = _3['default'];
    }, function (_4) {
      _classCallCheck = _4['default'];
    }, function (_f) {
      $ = _f.$;
      HTML = _f.HTML;
    }],
    execute: function () {

      // TODO the default template should be moved outside this module so that it can be easily skipped
      'use strict';

      DEFAULT_TEMPLATE_ID = 'template-coverage-parameter-discrete-legend';
      DEFAULT_TEMPLATE = '\n<template id="' + DEFAULT_TEMPLATE_ID + '">\n  <div class="info legend discrete-legend">\n    <strong class="legend-title"></strong><br>\n    <div class="legend-palette discrete-legend-palette"></div>\n  </div>\n</template>\n';
      DEFAULT_TEMPLATE_CSS = '\n.legend {\n  color: #555;\n}\n.discrete-legend-palette {\n  padding: 2px 1px;\n  line-height: 18px;\n}\n.discrete-legend-palette i {\n  float: left;\n  height: 18px;\n  margin-right: 8px;\n  opacity: 0.7;\n  width: 18px;\n}\n';

      /**
       * Displays a discrete palette legend for the parameter displayed by the given
       * Coverage layer. Supports category parameters only at the moment.
       * 
       * @example
       * new DiscreteLegend(covLayer).addTo(map)
       * 
       * @example <caption>Fake layer</caption>
       * var legend = new DiscreteLegend({parameter: {..}, palette: {...}}).addTo(map)
       * 
       * // either recreate the legend or update the fake layer in place:
       * legend.covLayer = {..}
       * legend.updateLegend()
       */

      DiscreteLegend = (function (_L$Control) {
        _inherits(DiscreteLegend, _L$Control);

        function DiscreteLegend(covLayer, options) {
          var _this = this;

          _classCallCheck(this, DiscreteLegend);

          _get(Object.getPrototypeOf(DiscreteLegend.prototype), 'constructor', this).call(this, options.position ? { position: options.position } : {});
          this.covLayer = covLayer;
          this.id = options.id || DEFAULT_TEMPLATE_ID;
          this.language = options.language || i18n.DEFAULT_LANGUAGE;

          if (!options.id && document.getElementById(DEFAULT_TEMPLATE_ID) === null) {
            inject(DEFAULT_TEMPLATE, DEFAULT_TEMPLATE_CSS);
          }

          if (covLayer.on) {
            (function () {
              // arrow function is broken here with traceur, this is a workaround
              // see https://github.com/google/traceur-compiler/issues/1987
              var self = _this;
              _this._remove = function () {
                self.removeFrom(self._map);
              };
              covLayer.on('remove', _this._remove);
            })();
          }
        }

        _createClass(DiscreteLegend, [{
          key: 'updateLegend',
          value: function updateLegend() {
            var el = this._el;

            var palette = this.covLayer.palette;
            var param = this.covLayer.parameter;

            var html = '';

            for (var i = 0; i < palette.steps; i++) {
              var cat = i18n.getLanguageString(param.categories[i].label, this.language);
              html += '\n        <i style="background:rgb(' + palette.red[i] + ', ' + palette.green[i] + ', ' + palette.blue[i] + ')"></i>\n        ' + cat + '\n        <br>';
            }

            $('.legend-palette', el).fill(HTML(html));
          }
        }, {
          key: 'onRemove',
          value: function onRemove(map) {
            var _this2 = this;

            if (this.covLayer.off) {
              this.covLayer.off('remove', this._remove);
              this.covLayer.off('paletteChange', function () {
                return _this2.updateLegend();
              });
            }
          }
        }, {
          key: 'onAdd',
          value: function onAdd(map) {
            var _this3 = this;

            this._map = map;

            if (this.covLayer.on) {
              this.covLayer.on('paletteChange', function () {
                return _this3.updateLegend();
              });
            }

            var param = this.covLayer.parameter;
            // if requested language doesn't exist, use the returned one for all other labels
            this.language = i18n.getLanguageTag(param.observedProperty.label, this.language);
            var title = i18n.getLanguageString(param.observedProperty.label, this.language);

            var el = document.importNode($('#' + this.id)[0].content, true).children[0];
            this._el = el;
            $('.legend-title', el).fill(title);
            this.updateLegend();

            return el;
          }
        }]);

        return DiscreteLegend;
      })(L.Control);

      _export('default', DiscreteLegend);
    }
  };
});

$__System.register('7', ['1', '12', '13', '14', '15', 'f'], function (_export) {
  var L, _get, _inherits, _createClass, _classCallCheck, $, TimeAxis;

  return {
    setters: [function (_5) {
      L = _5['default'];
    }, function (_) {
      _get = _['default'];
    }, function (_2) {
      _inherits = _2['default'];
    }, function (_3) {
      _createClass = _3['default'];
    }, function (_4) {
      _classCallCheck = _4['default'];
    }, function (_f) {
      $ = _f.$;
    }],
    execute: function () {

      /**
       * Displays a time axis selector for a given coverage layer.
       * Also listens to time axis changes which were not initiated from
       * this control.
       * 
       *  TODO figure out for which use cases this can realistically be used
       *  solve https://github.com/Reading-eScience-Centre/coverage-jsapi/issues/3 first
       */
      'use strict';

      TimeAxis = (function (_L$Control) {
        _inherits(TimeAxis, _L$Control);

        function TimeAxis(covLayer, options) {
          var _this = this;

          _classCallCheck(this, TimeAxis);

          _get(Object.getPrototypeOf(TimeAxis.prototype), 'constructor', this).call(this, options.position ? { position: options.position } : {});
          this.covLayer = covLayer;
          this.id = options.id || DEFAULT_TEMPLATE_ID;

          if (!options.id && document.getElementById(DEFAULT_TEMPLATE_ID) === null) {
            inject(DEFAULT_TEMPLATE, DEFAULT_TEMPLATE_CSS);
          }

          this._axisListener = function (e) {
            if (e.axis === 'time') _this.updateAxis();
          };

          // arrow function is broken here with traceur, this is a workaround
          // see https://github.com/google/traceur-compiler/issues/1987
          var self = this;
          this._remove = function () {
            self.removeFrom(self._map);
          };
          covLayer.on('remove', this._remove);
        }

        _createClass(TimeAxis, [{
          key: 'onRemove',
          value: function onRemove(map) {
            this.covLayer.off('remove', this._remove);
            this.covLayer.off('axisChange', this._axisListener);
          }
        }, {
          key: 'onAdd',
          value: function onAdd(map) {
            this._map = map;
            covLayer.on('axisChange', this._axisListener);
            var el = document.importNode($('#' + this.id)[0].content, true).children[0];
            this._el = el;
            this.updateAxis();

            return el;
          }
        }, {
          key: 'updateAxis',
          value: function updateAxis() {
            // TODO implement
          }
        }]);

        return TimeAxis;
      })(L.Control);

      _export('default', TimeAxis);
    }
  };
});

$__System.register('9', ['1', '12', '13', '14', '15', '16', '18', '19', '1c', '1d', '1e', '1f', 'c', '1a', '1b'], function (_export) {
  var L, _get, _inherits, _createClass, _classCallCheck, _slicedToArray, _Object$keys, ndarray, _toConsumableArray, _Promise, _getIterator, _Map, linearPalette, scale, arrays, opsnull, DOMAIN_TYPE, DEFAULT_CONTINUOUS_PALETTE, DEFAULT_CATEGORICAL_PALETTE, Grid;

  function wrapLongitude(lon, range) {
    return wrapNum(lon, range, true);
  }

  //stolen from https://github.com/Leaflet/Leaflet/blob/master/src/core/Util.js
  //doesn't exist in current release (0.7.3)
  function wrapNum(x, range, includeMax) {
    var max = range[1];
    var min = range[0];
    var d = max - min;
    return x === max && includeMax ? x : ((x - min) % d + d) % d + min;
  }
  return {
    setters: [function (_7) {
      L = _7['default'];
    }, function (_) {
      _get = _['default'];
    }, function (_2) {
      _inherits = _2['default'];
    }, function (_3) {
      _createClass = _3['default'];
    }, function (_4) {
      _classCallCheck = _4['default'];
    }, function (_5) {
      _slicedToArray = _5['default'];
    }, function (_6) {
      _Object$keys = _6['default'];
    }, function (_8) {
      ndarray = _8['default'];
    }, function (_c) {
      _toConsumableArray = _c['default'];
    }, function (_d) {
      _Promise = _d['default'];
    }, function (_e) {
      _getIterator = _e['default'];
    }, function (_f) {
      _Map = _f['default'];
    }, function (_c2) {
      linearPalette = _c2.linearPalette;
      scale = _c2.scale;
    }, function (_a) {
      arrays = _a;
    }, function (_b) {
      opsnull = _b;
    }],
    execute: function () {
      'use strict';

      DOMAIN_TYPE = 'http://coveragejson.org/def#Grid';

      DEFAULT_CONTINUOUS_PALETTE = function DEFAULT_CONTINUOUS_PALETTE() {
        return linearPalette(['#deebf7', '#3182bd']);
      };

      // blues

      DEFAULT_CATEGORICAL_PALETTE = function DEFAULT_CATEGORICAL_PALETTE(n) {
        return linearPalette(['#e41a1c', '#377eb8', '#4daf4a', '#984ea3'], n);
      };

      /**
       * Renderer for Coverages with domain type Grid.
       * 
       * Events fired onto the map:
       * "dataloading" - Data loading has started
       * "dataload" - Data loading has finished (also in case of errors)
       * 
       * Events fired on this layer:
       * "add" - Layer is initialized and is about to be added to the map
       * "remove" - Layer is removed from the map
       * "error" - Error when loading data
       * "paletteChange" - Palette has changed
       * "paletteExtentChange" - Palette extent has changed
       * "axisChange" - Axis coordinate has changed (e.axis === 'time'|'vertical')
       * "remove" - Layer is removed from the map
       * 
       */

      Grid = (function (_L$TileLayer$Canvas) {
        _inherits(Grid, _L$TileLayer$Canvas);

        /**
         * The parameter to display must be given as the 'parameter' options property.
         * 
         * Optional time and vertical axis target values can be defined with the 'time' and
         * 'vertical' options properties. The closest values on the respective axes are chosen.
         * 
         * Example: 
         * <pre><code>
         * var cov = ... // get Coverage data
         * var layer = new GridCoverage(cov, {
         *   keys: ['salinity'],
         *   time: new Date('2015-01-01T12:00:00Z'),
         *   vertical: 50,
         *   palette: palettes.get('blues'),
         *   paletteExtent: 'full' // or 'subset' (time/vertical), 'fov' (map field of view), or specific: [-10,10]
         * })
         * </code></pre>
         */

        function Grid(cov, options) {
          _classCallCheck(this, Grid);

          _get(Object.getPrototypeOf(Grid.prototype), 'constructor', this).call(this);
          if (cov.domainType !== DOMAIN_TYPE) {
            throw new Error('Unsupported domain type: ' + cov.domainType + ', must be: ' + DOMAIN_TYPE);
          }
          this.cov = cov;
          this.param = cov.parameters.get(options.keys[0]);
          this._axesSubset = { // x and y are not subsetted
            t: { coordPref: options.time },
            z: { coordPref: options.vertical }
          };

          if (options.palette) {
            this._palette = options.palette;
          } else if (this.param.categories) {
            this._palette = DEFAULT_CATEGORICAL_PALETTE(this.param.categories.length);
          } else {
            this._palette = DEFAULT_CONTINUOUS_PALETTE();
          }

          if (this.param.categories && this.param.categories.length !== this._palette.steps) {
            throw new Error('Categorical palettes must match the number of categories of the parameter');
          }

          if (this.param.categories) {
            if (options.paletteExtent) {
              throw new Error('paletteExtent cannot be given for categorical parameters');
            }
          } else {
            if (options.paletteExtent === undefined) {
              this._paletteExtent = 'full';
            } else if (Array.isArray(options.paletteExtent) || ['full', 'subset', 'fov'].indexOf(options.paletteExtent) !== -1) {
              this._paletteExtent = options.paletteExtent;
            } else {
              throw new Error('paletteExtent must either be a 2-element array, one of "full", "subset", or "fov", or be omitted');
            }
          }

          switch (options.redraw) {
            case 'manual':
              this._autoRedraw = false;break;
            case undefined:
            case 'onchange':
              this._autoRedraw = true;break;
            default:
              throw new Error('redraw must be "onchange", "manual", or omitted (defaults to "onchange")');
          }
        }

        _createClass(Grid, [{
          key: 'onAdd',
          value: function onAdd(map) {
            var _this = this;

            // "loading" and "load" events are provided by the underlying TileLayer class

            this._map = map;
            map.fire('dataloading'); // for supporting loading spinners
            _Promise.all([this.cov.loadDomain(), this.cov.loadRange(this.param.key)]).then(function (_ref) {
              var _ref2 = _slicedToArray(_ref, 2);

              var domain = _ref2[0];
              var range = _ref2[1];

              _this.domain = domain;
              _this.range = range;
              _this._subsetAxesByCoordinatePreference();
              if (!_this.param.categories) {
                _this._updatePaletteExtent(_this._paletteExtent);
              }
              _this.fire('add');
              _get(Object.getPrototypeOf(Grid.prototype), 'onAdd', _this).call(_this, map);
              map.fire('dataload');
            })['catch'](function (e) {
              console.error(e);
              _this.fire('error', e);

              map.fire('dataload');
            });
          }
        }, {
          key: 'onRemove',
          value: function onRemove(map) {
            delete this._map;
            this.fire('remove');
            _get(Object.getPrototypeOf(Grid.prototype), 'onRemove', this).call(this, map);
          }
        }, {
          key: 'getBounds',
          value: function getBounds() {
            if (this.cov.bbox) {
              var bbox = this.cov.bbox;
            } else if (this._isRectilinearGeodeticDomainGrid()) {
              var bbox = this._getDomainBbox();
            } else {
              return;
            }
            var southWest = L.latLng(bbox[1], bbox[0]);
            var northEast = L.latLng(bbox[3], bbox[2]);
            var bounds = new L.LatLngBounds(southWest, northEast);
            return bounds;
          }

          /**
           * Subsets the temporal and vertical axes based on the _axesSubset.*.coordPref property,
           * which is regarded as a preference and does not have to exactly match a coordinate.
           * 
           * After calling this method, _axesSubset.*.idx and _axesSubset.*.coord have
           * values from the actual axes.
           */
        }, {
          key: '_subsetAxesByCoordinatePreference',
          value: function _subsetAxesByCoordinatePreference() {
            var _iteratorNormalCompletion = true;
            var _didIteratorError = false;
            var _iteratorError = undefined;

            try {
              for (var _iterator = _getIterator(_Object$keys(this._axesSubset)), _step; !(_iteratorNormalCompletion = (_step = _iterator.next()).done); _iteratorNormalCompletion = true) {
                var axis = _step.value;

                var ax = this._axesSubset[axis];
                if (ax.coordPref == undefined) {
                  // == also handles null
                  ax.idx = 0;
                } else {
                  ax.idx = this._getClosestIndex(axis, ax.coordPref);
                }
                ax.coord = this.domain[axis] ? this.domain[axis][ax.idx] : null;
              }
            } catch (err) {
              _didIteratorError = true;
              _iteratorError = err;
            } finally {
              try {
                if (!_iteratorNormalCompletion && _iterator['return']) {
                  _iterator['return']();
                }
              } finally {
                if (_didIteratorError) {
                  throw _iteratorError;
                }
              }
            }
          }

          /**
           * Subsets the temporal and vertical axes based on the _axesSubset.*.idx property
           * which has been explicitly set.
           * 
           * After calling this method, the _axesSubset.*.coord properties have
           * values from the actual axes.
           */
        }, {
          key: '_subsetAxesByIndex',
          value: function _subsetAxesByIndex() {
            var _iteratorNormalCompletion2 = true;
            var _didIteratorError2 = false;
            var _iteratorError2 = undefined;

            try {
              for (var _iterator2 = _getIterator(_Object$keys(this._axesSubset)), _step2; !(_iteratorNormalCompletion2 = (_step2 = _iterator2.next()).done); _iteratorNormalCompletion2 = true) {
                var axis = _step2.value;

                var ax = this._axesSubset[axis];
                ax.coord = this.domain[axis] ? this.domain[axis][ax.idx] : null;
                delete ax.coordPref; // in case it was set
              }
            } catch (err) {
              _didIteratorError2 = true;
              _iteratorError2 = err;
            } finally {
              try {
                if (!_iteratorNormalCompletion2 && _iterator2['return']) {
                  _iterator2['return']();
                }
              } finally {
                if (_didIteratorError2) {
                  throw _iteratorError2;
                }
              }
            }
          }

          /**
           * Return the index of the coordinate value closest to the given value
           * within the given axis. Supports ascending and descending axes.
           * If the axis is empty, then 0 is returned, since we regard an empty axis
           * as consisting of a single "unknown" coordinate value.
           */
        }, {
          key: '_getClosestIndex',
          value: function _getClosestIndex(axis, val) {
            if (!(axis in this.domain)) {
              return 0;
            }
            var vals = this.domain[axis];
            var idx = arrays.indexOfNearest(vals, val);
            return idx;
          }
        }, {
          key: '_updatePaletteExtent',
          value: function _updatePaletteExtent(extent) {
            var _arr, _arr2;

            if (Array.isArray(extent) && extent.length === 2) {
              this._paletteExtent = extent;
              return;
            }

            // wrapping as SciJS's ndarray allows us to do easy subsetting and efficient min/max search
            var arr = arrays.asSciJSndarray(this.range.values);
            var sub = this._axesSubset;

            if (extent === 'full') {
              // scan the whole range for min/max values, don't subset

            } else if (extent === 'subset') {
                // scan the current subset (per _axesSubset) for min/max values
                arr = arr.pick(sub.t.idx, sub.z.idx, null, null);
              } else if (extent === 'fov') {
                // scan the values that are currently in field of view on the map for min/max
                // this implies using the current subset
                var bounds = this._map.getBounds();

                // TODO implement
                throw new Error('NOT IMPLEMENTED YET');
              } else {
                throw new Error('Unknown extent specification: ' + extent);
              }

            this._paletteExtent = [(_arr = arr).get.apply(_arr, _toConsumableArray(opsnull.nullargmin(arr))), (_arr2 = arr).get.apply(_arr2, _toConsumableArray(opsnull.nullargmax(arr)))];
          }
        }, {
          key: 'drawTile',
          value: function drawTile(canvas, tilePoint, zoom) {
            var _this2 = this;

            var map = this._map;
            var ctx = canvas.getContext('2d');
            var tileSize = this.options.tileSize;

            var imgData = ctx.getImageData(0, 0, tileSize, tileSize);
            // Uint8ClampedArray, 1-dimensional, in order R,G,B,A,R,G,B,A,... row-major
            var rgba = ndarray(imgData.data, [tileSize, tileSize, 4]);

            // projection coordinates of top left tile pixel
            var start = tilePoint.multiplyBy(tileSize);
            var startX = start.x;
            var startY = start.y;

            var palette = this.palette;
            var _palette = this.palette;
            var red = _palette.red;
            var green = _palette.green;
            var blue = _palette.blue;

            var paletteExtent = this.paletteExtent;

            var doSetPixel = function doSetPixel(tileY, tileX, idx) {
              rgba.set(tileY, tileX, 0, red[idx]);
              rgba.set(tileY, tileX, 1, green[idx]);
              rgba.set(tileY, tileX, 2, blue[idx]);
              rgba.set(tileY, tileX, 3, 255);
            };

            var setPixel = undefined;
            if (this.param.categories) {
              var _iteratorNormalCompletion3;

              var _didIteratorError3;

              var _iteratorError3;

              var _iterator3, _step3;

              (function () {
                // categorical parameter
                var valIdxMap = new _Map();
                for (var idx = 0; idx < _this2.param.categories.length; idx++) {
                  var cat = _this2.param.categories[idx];
                  if (cat.value) {
                    valIdxMap.set(cat.value, idx);
                  } else {
                    _iteratorNormalCompletion3 = true;
                    _didIteratorError3 = false;
                    _iteratorError3 = undefined;

                    try {
                      for (_iterator3 = _getIterator(cat.values); !(_iteratorNormalCompletion3 = (_step3 = _iterator3.next()).done); _iteratorNormalCompletion3 = true) {
                        var val = _step3.value;

                        valIdxMap.set(val, idx);
                      }
                    } catch (err) {
                      _didIteratorError3 = true;
                      _iteratorError3 = err;
                    } finally {
                      try {
                        if (!_iteratorNormalCompletion3 && _iterator3['return']) {
                          _iterator3['return']();
                        }
                      } finally {
                        if (_didIteratorError3) {
                          throw _iteratorError3;
                        }
                      }
                    }
                  }
                }
                setPixel = function (tileY, tileX, val) {
                  if (val === null || !valIdxMap.has(val)) return;
                  var idx = valIdxMap.get(val);
                  doSetPixel(tileY, tileX, idx);
                };
              })();
            } else {
              // continuous parameter
              setPixel = function (tileY, tileX, val) {
                if (val === null) return;
                var idx = scale(val, palette, paletteExtent);
                doSetPixel(tileY, tileX, idx);
              };
            }

            var sub = this._axesSubset;
            var vals = arrays.asSciJSndarray(this.range.values).pick(sub.t.idx, sub.z.idx, null, null);

            if (this._isRectilinearGeodeticDomainGrid()) {
              if (this._isProjectedCoverageCRS()) {
                // unproject to lon/lat first
                // TODO how can we do that? this means adding a dependency to proj4js!
                // should probably be made optional since this is an edge case
                throw new Error('NOT IMPLEMENTED YET');
              }
              if (this._isRectilinearGeodeticMap()) {
                // here we can apply heavy optimizations
                this._drawRectilinearGeodeticMapProjection(setPixel, tileSize, startX, startY, vals);
              } else {
                // this is for any random map projection
                // here we have to unproject each map pixel individually and find the matching domain coordinates
                this._drawAnyMapProjection(setPixel, tileSize, startX, startY, vals);
              }
            } else {
              if (true /*map CRS == domain CRS*/) {
                  // TODO implement
                  throw new Error('NOT IMPLEMENTED YET');
                } else {
                // here we would have to reproject the coverage
                // since this is not feasible in browsers, we just throw an error
                throw new Error('The map CRS must match the Coverage CRS ' + 'if the latter cannot be mapped to a rectilinear geodetic grid');
              }
            }

            ctx.putImageData(imgData, 0, 0);
          }

          /**
           * Derives the bounding box of the x,y axes in CRS coordinates.
           * @returns {Array} [xmin,ymin,xmax,ymax]
           */
        }, {
          key: '_getDomainBbox',
          value: function _getDomainBbox() {
            // TODO use bounds if they are supplied
            var xend = this.domain.x.length - 1;
            var yend = this.domain.y.length - 1;
            var xmin = this.domain.x[0];
            var xmax = this.domain.x[xend];
            var ymin = this.domain.y[0];
            var ymax = this.domain.y[yend];

            // TODO only enlarge when bounds haven't been used above
            if (this.domain.x.length > 1) {
              xmin -= Math.abs(this.domain.x[0] - this.domain.x[1]) / 2;
              xmax += Math.abs(this.domain.x[xend] - this.domain.x[xend - 1]) / 2;
            }
            if (this.domain.y.length > 1) {
              ymin -= Math.abs(this.domain.y[0] - this.domain.y[1]) / 2;
              ymax += Math.abs(this.domain.y[yend] - this.domain.y[yend - 1]) / 2;
            }
            if (xmin > xmax) {
              var _ref3 = [xmax, xmin];
              xmin = _ref3[0];
              xmax = _ref3[1];
            }
            if (ymin > ymax) {
              var _ref4 = [ymax, ymin];
              ymin = _ref4[0];
              ymax = _ref4[1];
            }
            return [xmin, ymin, xmax, ymax];
          }

          /**
           * Draws a geodetic rectilinear domain grid on a map with arbitrary projection.
           * 
           * @param {Function} setPixel A function with parameters (y,x,val) which 
           *                            sets the color of a pixel on a tile.
           * @param {Integer} tileSize Size of a tile in pixels.
           * @param {Integer} startX
           * @param {Integer} startY
           * @param {ndarray} vals Range values.
           */
        }, {
          key: '_drawAnyMapProjection',
          value: function _drawAnyMapProjection(setPixel, tileSize, startX, startY, vals) {
            // usable for any map projection, but computationally more intensive
            // there are two hotspots in the loops: map.unproject and indexOfNearest

            var map = this._map;
            var _domain = this.domain;
            var x = _domain.x;
            var y = _domain.y;

            var bbox = this._getDomainBbox();
            var lonRange = [bbox[0], bbox[0] + 360];

            for (var tileX = 0; tileX < tileSize; tileX++) {
              for (var tileY = 0; tileY < tileSize; tileY++) {
                var _map$unproject = map.unproject(L.point(startX + tileX, startY + tileY));

                var lat = _map$unproject.lat;
                var lon = _map$unproject.lon;

                // we first check whether the tile pixel is outside the domain bounding box
                // in that case we skip it as we do not want to extrapolate
                if (lat < bbox[1] || lat > bbox[3]) {
                  continue;
                }

                lon = wrapLongitude(lon, lonRange);
                if (lon < bbox[0] || lon > bbox[2]) {
                  continue;
                }

                // now we find the closest grid cell using simple binary search
                // for finding the closest latitude/longitude we use a simple binary search
                // (as there is no discontinuity)
                var iLat = arrays.indexOfNearest(y, lat);
                var iLon = arrays.indexOfNearest(x, lon);

                setPixel(tileY, tileX, vals.get(iLat, iLon));
              }
            }
          }

          /**
           * Draws a geodetic rectilinear domain grid on a map whose grid is, or can be directly
           * mapped to, a geodetic rectilinear grid.
           */
        }, {
          key: '_drawRectilinearGeodeticMapProjection',
          value: function _drawRectilinearGeodeticMapProjection(setPixel, tileSize, startX, startY, vals) {
            // optimized version for map projections that are equal to a rectilinear geodetic grid
            // this can be used when lat and lon can be computed independently for a given pixel

            var map = this._map;
            var _domain2 = this.domain;
            var x = _domain2.x;
            var y = _domain2.y;

            var bbox = this._getDomainBbox();
            var lonRange = [bbox[0], bbox[0] + 360];

            var latCache = new Float64Array(tileSize);
            var iLatCache = new Uint32Array(tileSize);
            for (var tileY = 0; tileY < tileSize; tileY++) {
              var lat = map.unproject(L.point(startX, startY + tileY)).lat;
              latCache[tileY] = lat;
              // find the index of the closest latitude in the grid using simple binary search
              iLatCache[tileY] = arrays.indexOfNearest(y, lat);
            }

            for (var tileX = 0; tileX < tileSize; tileX++) {
              var lon = map.unproject(L.point(startX + tileX, startY)).lng;
              lon = wrapLongitude(lon, lonRange);
              if (lon < bbox[0] || lon > bbox[2]) {
                continue;
              }

              // find the index of the closest longitude in the grid using simple binary search
              // (as there is no discontinuity)
              var iLon = arrays.indexOfNearest(x, lon);

              for (var tileY = 0; tileY < tileSize; tileY++) {
                // get geographic coordinates of tile pixel
                var _lat = latCache[tileY];

                // we first check whether the tile pixel is outside the domain bounding box
                // in that case we skip it as we do not want to extrapolate
                if (_lat < bbox[1] || _lat > bbox[3]) {
                  continue;
                }

                var iLat = iLatCache[tileY];

                setPixel(tileY, tileX, vals.get(iLat, iLon));
              }
            }
          }

          /**
           * Return true if the map projection grid can be mapped to a rectilinear
           * geodetic grid. For that, it must satisfy:
           * for all x, there is a longitude lon, for all y, unproject(x,y).lon = lon
           * for all y, there is a latitude lat, for all x, unproject(x,y).lat = lat
           * 
           * Returns false if this is not the case or unknown.
           */
        }, {
          key: '_isRectilinearGeodeticMap',
          value: function _isRectilinearGeodeticMap() {
            var crs = this._map.options.crs;
            // these are the ones included in Leaflet
            var recti = [L.CRS.EPSG3857, L.CRS.EPSG4326, L.CRS.EPSG3395, L.CRS.Simple];
            var isRecti = recti.indexOf(crs) !== -1;
            // TODO for unknown ones, how do we test that?
            return isRecti;
          }

          /**
           * Same as _isRectilinearGeodeticMap but for the coverage CRS.
           */
        }, {
          key: '_isRectilinearGeodeticDomainGrid',
          value: function _isRectilinearGeodeticDomainGrid() {
            var _this3 = this;

            if (!this.domain.crs) {
              // defaults to CRS84 if not given
              return true;
            }
            // TODO add other common ones or somehow detect it automatically
            var recti = ['http://www.opengis.net/def/crs/OGC/1.3/CRS84'];
            return recti.some(function (r) {
              return _this3.domain.crs === r;
            });
          }

          /**
           * Whether the CRS of the coverage is a projected one, meaning
           * that x and y are not geographic coordinates (lon/lat) but easting and northing
           * which have to be converted to geographic coordinates.
           */
        }, {
          key: '_isProjectedCoverageCRS',
          value: function _isProjectedCoverageCRS() {
            var _this4 = this;

            if (!this.domain.crs) {
              return false;
            }
            var geographic = ['http://www.opengis.net/def/crs/OGC/1.3/CRS84'];
            return !geographic.some(function (uri) {
              return _this4.domain.crs === uri;
            });
          }
        }, {
          key: '_doAutoRedraw',
          value: function _doAutoRedraw() {
            // we check getContainer() to prevent errors when trying to redraw when the layer has not
            // fully initialized yet
            if (this._autoRedraw && this.getContainer()) {
              this.redraw();
            }
          }
        }, {
          key: 'parameter',
          get: function get() {
            return this.param;
          }

          /**
           * Sets the currently active time to the one closest to the given Date object.
           * This has no effect if the grid has no time axis.
           */
        }, {
          key: 'time',
          set: function set(val) {
            var old = this.time;
            this._axesSubset.t.coordPref = val;
            this._subsetAxesByPreference();
            this._doAutoRedraw();
            if (old !== this.time) {
              this.fire('axisChange', { axis: 'time' });
            }
          },

          /**
           * The currently active time on the temporal axis as Date object, 
           * or null if the grid has no time axis.
           */
          get: function get() {
            return this._axesSubset.t.coord;
          }

          /**
           * Sets the currently active vertical coordinate to the one closest to the given value.
           * This has no effect if the grid has no vertical axis.
           */
        }, {
          key: 'vertical',
          set: function set(val) {
            var old = this.vertical;
            this._axesSubset.z.coordPref = val;
            this._subsetAxesByPreference();
            this._doAutoRedraw();
            if (old !== this.vertical) {
              this.fire('axisChange', { axis: 'vertical' });
            }
          },

          /**
           * The currently active vertical coordinate as a number, 
           * or null if the grid has no vertical axis.
           */
          get: function get() {
            return this._axesSubset.z.coord;
          }
        }, {
          key: 'palette',
          set: function set(p) {
            this._palette = p;
            this._doAutoRedraw();
            this.fire('paletteChange');
          },
          get: function get() {
            return this._palette;
          }
        }, {
          key: 'paletteExtent',
          set: function set(extent) {
            if (this.param.categories) {
              throw new Error('Cannot set palette extent for categorical parameters');
            }
            this._updatePaletteExtent(extent);
            this._doAutoRedraw();
            this.fire('paletteExtentChange');
          },
          get: function get() {
            return this._paletteExtent;
          }
        }]);

        return Grid;
      })(L.TileLayer.Canvas);

      _export('default', Grid);
    }
  };
});

$__System.register('a', ['1', '12', '13', '14', '15', '16', '1c', '1d', 'c', '1a', '1b'], function (_export) {
  var L, _get, _inherits, _createClass, _classCallCheck, _slicedToArray, _toConsumableArray, _Promise, linearPalette, scale, arrays, opsnull, DOMAIN_TYPE, DEFAULT_COLOR, DEFAULT_PALETTE, Profile;

  return {
    setters: [function (_6) {
      L = _6['default'];
    }, function (_) {
      _get = _['default'];
    }, function (_2) {
      _inherits = _2['default'];
    }, function (_3) {
      _createClass = _3['default'];
    }, function (_4) {
      _classCallCheck = _4['default'];
    }, function (_5) {
      _slicedToArray = _5['default'];
    }, function (_c) {
      _toConsumableArray = _c['default'];
    }, function (_d) {
      _Promise = _d['default'];
    }, function (_c2) {
      linearPalette = _c2.linearPalette;
      scale = _c2.scale;
    }, function (_a) {
      arrays = _a;
    }, function (_b) {
      opsnull = _b;
    }],
    execute: function () {
      'use strict';

      DOMAIN_TYPE = 'http://coveragejson.org/def#Profile';
      DEFAULT_COLOR = 'black';
      DEFAULT_PALETTE = linearPalette(['#deebf7', '#3182bd']);
      // blues

      /**
       * Renderer for Coverages with domain type Profile.
       * 
       * This will simply display a dot on the map and fire a click
       * event when a user clicks on it.
       * The dot either has a defined standard color, or it uses
       * a palette together with a target depth if a parameter is chosen.
       */

      Profile = (function (_L$Class) {
        _inherits(Profile, _L$Class);

        function Profile(cov, options) {
          _classCallCheck(this, Profile);

          _get(Object.getPrototypeOf(Profile.prototype), 'constructor', this).call(this);
          if (cov.domainType !== DOMAIN_TYPE) {
            throw new Error('Unsupported domain type: ' + cov.domainType + ', must be: ' + DOMAIN_TYPE);
          }
          this.cov = cov;
          this.param = options.keys ? cov.parameters.get(options.keys[0]) : null;
          this._targetZ = 'targetZ' in options ? options.targetZ : null;
          this.defaultColor = options.color ? options.color : DEFAULT_COLOR;

          if (this.param && this.param.categories) {
            throw new Error('category parameters are currently not support for Profile');
          }

          this._palette = options.palette || DEFAULT_PALETTE;
          if (Array.isArray(options.paletteExtent)) {
            this._paletteExtent = options.paletteExtent;
          } else {
            this._paletteExtent = 'full';
          }

          // TODO remove code duplication
          switch (options.redraw) {
            case 'manual':
              this._autoRedraw = false;break;
            case undefined:
            case 'onchange':
              this._autoRedraw = true;break;
            default:
              throw new Error('redraw must be "onchange", "manual", or omitted (defaults to "onchange")');
          }
        }

        _createClass(Profile, [{
          key: 'onAdd',
          value: function onAdd(map) {
            var _this = this;

            this._map = map;

            map.fire('dataloading'); // for supporting loading spinners

            var promise = undefined;
            if (this.param) {
              promise = _Promise.all([this.cov.loadDomain(), this.cov.loadRange(this.param.key)]).then(function (_ref) {
                var _ref2 = _slicedToArray(_ref, 2);

                var domain = _ref2[0];
                var range = _ref2[1];

                console.log('domain and range loaded');
                _this.domain = domain;
                _this.range = range;
                _this._updatePaletteExtent(_this._paletteExtent);
                _this._addMarker();
                _this.fire('add');
                map.fire('dataload');
              });
            } else {
              promise = this.cov.loadDomain().then(function (domain) {
                console.log('domain loaded');
                _this.domain = domain;
                _this._addMarker();
                _this.fire('add');
                map.fire('dataload');
              });
            }

            promise['catch'](function (e) {
              console.error(e);
              _this.fire('error', e);

              map.fire('dataload');
            });
          }
        }, {
          key: 'onRemove',
          value: function onRemove(map) {
            this.fire('remove');
            this._removeMarker();
          }
        }, {
          key: 'getBounds',
          value: function getBounds() {
            return this.marker.getBounds();
          }
        }, {
          key: '_updatePaletteExtent',
          value: function _updatePaletteExtent(extent) {
            if (Array.isArray(extent) && extent.length === 2) {
              this._paletteExtent = extent;
              return;
            }

            if (!this.param) {
              throw new Error('palette extent cannot be set when no trajectory parameter has been chosen');
            }

            // wrapping as SciJS's ndarray allows us to do easy subsetting and efficient min/max search
            var arr = arrays.asSciJSndarray(this.range.values);

            // scan the whole range for min/max values
            this._paletteExtent = [arr.get.apply(arr, _toConsumableArray(opsnull.nullargmin(arr))), arr.get.apply(arr, _toConsumableArray(opsnull.nullargmax(arr)))];
          }
        }, {
          key: '_addMarker',
          value: function _addMarker() {
            var _this2 = this;

            var _domain = this.domain;
            var x = _domain.x;
            var y = _domain.y;

            this.marker = L.circleMarker(L.latLng(y, x), { color: this._getColor() });

            this.marker.on('click', function (e) {
              _this2.fire('click');
            });

            this.marker.addTo(this._map);
          }
        }, {
          key: '_removeMarker',
          value: function _removeMarker() {
            this._map.removeLayer(this.marker);
            delete this.marker;
          }
        }, {
          key: '_getColor',
          value: function _getColor() {
            var _domain2 = this.domain;
            var x = _domain2.x;
            var y = _domain2.y;
            var z = _domain2.z;

            // TODO do coordinate transformation to lat/lon if necessary

            if (this.param && this.targetZ !== null) {
              // use a palette
              // find the value with z nearest to targetZ
              var val = this.range.get(z[arrays.indexOfNearest(z, this.targetZ)]);
              if (val !== null) {
                var valScaled = scale(val, this.palette, this.paletteExtent);
                var _palette = this.palette;
                var red = _palette.red;
                var green = _palette.green;
                var blue = _palette.blue;

                return 'rgb(' + red[valScaled] + ', ' + green[valScaled] + ', ' + blue[valScaled] + ')';
              }
            }
            return this.defaultColor;
          }
        }, {
          key: '_updateMarker',
          value: function _updateMarker() {
            this.marker.options.color = this._getColor();
          }
        }, {
          key: '_doAutoRedraw',
          value: function _doAutoRedraw() {
            if (this._autoRedraw) {
              this.redraw();
            }
          }
        }, {
          key: 'redraw',
          value: function redraw() {
            this._updateMarker();
            this.marker.redraw();
          }
        }, {
          key: 'parameter',
          get: function get() {
            return this.param;
          }
        }, {
          key: 'targetZ',
          get: function get() {
            return this._targetZ;
          },
          set: function set(z) {
            this._targetZ = z;
            this._doAutoRedraw();
            this.fire('targetZChange');
          }
        }, {
          key: 'palette',
          set: function set(p) {
            this._palette = p;
            this._doAutoRedraw();
            this.fire('paletteChange');
          },
          get: function get() {
            return this.param && this.targetZ !== null ? this._palette : null;
          }
        }, {
          key: 'paletteExtent',
          set: function set(extent) {
            this._updatePaletteExtent(extent);
            this._doAutoRedraw();
            this.fire('paletteExtentChange');
          },
          get: function get() {
            return this._paletteExtent;
          }
        }]);

        return Profile;
      })(L.Class);

      _export('Profile', Profile);

      Profile.include(L.Mixin.Events);

      // work-around for Babel bug, otherwise Profile cannot be referenced here

      _export('default', Profile);
    }
  };
});

$__System.register('b', ['1', '12', '13', '14', '15', '16', '1c', '1d', 'c', '1a', '1b'], function (_export) {
  var L, _get, _inherits, _createClass, _classCallCheck, _slicedToArray, _toConsumableArray, _Promise, linearPalette, scale, arrays, opsnull, DOMAIN_TYPE, DEFAULT_PALETTE, Trajectory;

  return {
    setters: [function (_6) {
      L = _6['default'];
    }, function (_) {
      _get = _['default'];
    }, function (_2) {
      _inherits = _2['default'];
    }, function (_3) {
      _createClass = _3['default'];
    }, function (_4) {
      _classCallCheck = _4['default'];
    }, function (_5) {
      _slicedToArray = _5['default'];
    }, function (_c) {
      _toConsumableArray = _c['default'];
    }, function (_d) {
      _Promise = _d['default'];
    }, function (_c2) {
      linearPalette = _c2.linearPalette;
      scale = _c2.scale;
    }, function (_a) {
      arrays = _a;
    }, function (_b) {
      opsnull = _b;
    }],
    execute: function () {
      'use strict';

      DOMAIN_TYPE = 'http://coveragejson.org/def#Trajectory';
      DEFAULT_PALETTE = linearPalette(['#deebf7', '#3182bd']);
      // blues

      /**
       * Renderer for Coverages with domain type Trajectory.
       * 
       * Displays the trajectory as a path with coloured points using
       * a given palette for a given parameter.
       * 
       * Events fired onto the map:
       * "dataloading" - Data loading has started
       * "dataload" - Data loading has finished (also in case of errors)
       * 
       * Events fired on this layer:
       * "add" - Layer is initialized and is about to be added to the map
       * "remove" - Layer is removed from the map
       * "error" - Error when loading data
       * "paletteChange" - Palette has changed
       * "paletteExtentChange" - Palette extent has changed
       * 
       */

      Trajectory = (function (_L$FeatureGroup) {
        _inherits(Trajectory, _L$FeatureGroup);

        // TODO FeatureGroup is not ideal since click events etc should not be blindly propagated
        //    (we use it for now to have getBounds() which LayerGroup misses)

        function Trajectory(cov, options) {
          _classCallCheck(this, Trajectory);

          _get(Object.getPrototypeOf(Trajectory.prototype), 'constructor', this).call(this);
          if (cov.domainType !== DOMAIN_TYPE) {
            throw new Error('Unsupported domain type: ' + cov.domainType + ', must be: ' + DOMAIN_TYPE);
          }
          this.cov = cov;
          this.param = cov.parameters.get(options.keys[0]);

          if (this.param.categories) {
            throw new Error('category parameters are currently not support for Trajectory');
          }

          this._palette = options.palette || DEFAULT_PALETTE;
          if (options.paletteExtent === undefined || options.paletteExtent === 'subset') {
            this._paletteExtent = 'full';
          } else if (Array.isArray(options.paletteExtent) || ['full', 'fov'].indexOf(options.paletteExtent) !== -1) {
            this._paletteExtent = options.paletteExtent;
          } else {
            throw new Error('paletteExtent must either be a 2-element array, ' + 'one of "full", "subset" (identical to "full" for trajectories) or "fov", or be omitted');
          }
          // TODO remove code duplication
          switch (options.redraw) {
            case 'manual':
              this._autoRedraw = false;break;
            case undefined:
            case 'onchange':
              this._autoRedraw = true;break;
            default:
              throw new Error('redraw must be "onchange", "manual", or omitted (defaults to "onchange")');
          }

          console.log('Trajectory layer created');
        }

        _createClass(Trajectory, [{
          key: 'onAdd',
          value: function onAdd(map) {
            var _this = this;

            console.log('adding trajectory to map');
            this._map = map;
            map.fire('dataloading'); // for supporting loading spinners
            _Promise.all([this.cov.loadDomain(), this.cov.loadRange(this.param.key)]).then(function (_ref) {
              var _ref2 = _slicedToArray(_ref, 2);

              var domain = _ref2[0];
              var range = _ref2[1];

              console.log('domain and range loaded');
              _this.domain = domain;
              _this.range = range;
              _this._updatePaletteExtent(_this._paletteExtent);
              _this._addTrajectoryLayers();
              _this.fire('add');
              _get(Object.getPrototypeOf(Trajectory.prototype), 'onAdd', _this).call(_this, map);
              map.fire('dataload');
            })['catch'](function (e) {
              console.error(e);
              _this.fire('error', e);

              map.fire('dataload');
            });
          }
        }, {
          key: 'onRemove',
          value: function onRemove(map) {
            this.fire('remove');
            console.log('removing trajectory from map');
            _get(Object.getPrototypeOf(Trajectory.prototype), 'onRemove', this).call(this, map);
          }
        }, {
          key: '_updatePaletteExtent',
          value: function _updatePaletteExtent(extent) {
            if (Array.isArray(extent) && extent.length === 2) {
              this._paletteExtent = extent;
              return;
            }

            // wrapping as SciJS's ndarray allows us to do easy subsetting and efficient min/max search
            var arr = arrays.asSciJSndarray(this.range.values);

            if (extent === 'full') {
              // scan the whole range for min/max values, don't subset

            } else if (extent === 'fov') {
                // scan the values that are currently in field of view on the map for min/max
                var bounds = this._map.getBounds();

                // TODO implement
                throw new Error('NOT IMPLEMENTED YET');
              } else {
                throw new Error('Unknown extent specification: ' + extent);
              }

            this._paletteExtent = [arr.get.apply(arr, _toConsumableArray(opsnull.nullargmin(arr))), arr.get.apply(arr, _toConsumableArray(opsnull.nullargmax(arr)))];
          }
        }, {
          key: '_addTrajectoryLayers',
          value: function _addTrajectoryLayers() {
            // add a Polyline in black, and coloured CircleMarker's for each domain point
            var _domain = this.domain;
            var x = _domain.x;
            var y = _domain.y;
            var z = _domain.z;
            var t = _domain.t;

            var vals = this.range.values;

            // TODO do coordinate transformation to lat/lon if necessary

            var palette = this.palette;
            var _palette = this.palette;
            var red = _palette.red;
            var green = _palette.green;
            var blue = _palette.blue;

            var paletteExtent = this.paletteExtent;

            var coords = [];
            var markers = [];
            for (var i = 0; i < x.length; i++) {
              var val = vals.get(i);
              // this always has to be lat/lon, no matter which map projection is used
              var coord = new L.LatLng(y[i], x[i]);
              coords.push(coord);
              if (val !== null) {
                var valScaled = scale(val, palette, paletteExtent);
                var marker = new L.CircleMarker(coord, {
                  color: 'rgb(' + red[valScaled] + ', ' + green[valScaled] + ', ' + blue[valScaled] + ')',
                  opacity: 1,
                  fillOpacity: 1
                });
                this.addLayer(marker);
              }
            }

            var polyline = L.polyline(coords, {
              color: 'black',
              weight: 3
            });

            this.addLayer(polyline);
          }
        }, {
          key: '_doAutoRedraw',
          value: function _doAutoRedraw() {
            if (this._autoRedraw) {
              this.redraw();
            }
          }
        }, {
          key: 'redraw',
          value: function redraw() {
            this.clearLayers();
            this._addTrajectoryLayers();
          }
        }, {
          key: 'parameter',
          get: function get() {
            return this.param;
          }
        }, {
          key: 'palette',
          set: function set(p) {
            this._palette = p;
            this._doAutoRedraw();
            this.fire('paletteChange');
          },
          get: function get() {
            return this._palette;
          }
        }, {
          key: 'paletteExtent',
          set: function set(extent) {
            this._updatePaletteExtent(extent);
            this._doAutoRedraw();
            this.fire('paletteExtentChange');
          },
          get: function get() {
            return this._paletteExtent;
          }
        }]);

        return Trajectory;
      })(L.FeatureGroup);

      Trajectory.include(L.Mixin.Events);

      // work-around for Babel bug, otherwise Trajectory cannot be referenced here

      _export('default', Trajectory);
    }
  };
});

$__System.register('c', ['14', '15', '20', '21', '1f'], function (_export) {
  var _createClass, _classCallCheck, _Math$trunc, _Symbol$iterator, _Map, PaletteManager;

  function linearPalette(colors) {
    var steps = arguments.length <= 1 || arguments[1] === undefined ? 256 : arguments[1];

    // draw the gradient in a canvas
    var canvas = document.createElement('canvas');
    canvas.width = steps;
    canvas.height = 1;
    var ctx = canvas.getContext('2d');
    var gradient = ctx.createLinearGradient(0, 0, steps - 1, 0);
    var num = colors.length;
    for (var i = 0; i < num; i++) {
      gradient.addColorStop(i / (num - 1), colors[i]);
    }
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, steps, 1);

    // now read back values into arrays
    var red = new Uint8Array(steps);
    var green = new Uint8Array(steps);
    var blue = new Uint8Array(steps);

    var pix = ctx.getImageData(0, 0, steps, 1).data;
    for (var _i = 0, j = 0; _i < pix.length; _i += 4, j++) {
      red[j] = pix[_i];
      green[j] = pix[_i + 1];
      blue[j] = pix[_i + 2];
    }

    return {
      steps: red.length,
      red: red,
      green: green,
      blue: blue
    };
  }

  /**
   * Converts an array of CSS colors to a palette of the same size.
   */

  function directPalette(colors) {
    var canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    var ctx = canvas.getContext('2d');

    var steps = colors.length;

    var red = new Uint8Array(steps);
    var green = new Uint8Array(steps);
    var blue = new Uint8Array(steps);

    for (var i = 0; i < colors.length; i++) {
      ctx.fillStyle = colors[i];
      ctx.fillRect(0, 0, 1, 1);
      var pix = ctx.getImageData(0, 0, 1, 1).data;
      red[i] = pix[0];
      green[i] = pix[1];
      blue[i] = pix[2];
    }

    return {
      steps: red.length,
      red: red,
      green: green,
      blue: blue
    };
  }

  function scale(val, palette, extent) {
    // scale val to [0,paletteSize-1] using the palette extent
    // (IDL bytscl formula: http://www.exelisvis.com/docs/BYTSCL.html)
    var scaled = _Math$trunc((palette.steps - 1 + 0.9999) * (val - extent[0]) / (extent[1] - extent[0]));
    return scaled;
  }

  /**
   * Manages palettes under common names.
   * 
   * Palettes can have different numbers of steps.
   * Linear palettes can be conveniently added by supplying an array of CSS color specifications.
   * Generic palettes can be added by directly supplying the step colors as RGB arrays. 
   * 
   * Example:
   * <pre><code>
   * var palettes = new PaletteManager({defaultSteps: 10})
   * palettes.addLinear('grayscale', ['#FFFFFF', '#000000']) // has 10 steps
   * palettes.addLinear('grayscalehd', ['#FFFFFF', '#000000'], {steps=1000}) // high-resolution palette
   * palettes.add('breweroranges3', ['#fee6ce', '#fdae6b', '#e6550d']) // palette of exactly those 3 colors
   * palettes.add('mycustom', {red: [0,255], green: [0,0], blue: [10,20]}) // different syntax
   * </code></pre>
   * 
   * Note that Uint8Array typed arrays should be used for custom palettes (added via add()) to avoid
   * internal transformation.
   */

  function _asUint8Array(arr) {
    var ta = new Uint8Array(arr.length);
    for (var i = 0; i < arr.length; i++) {
      var val = arr[i];
      if (val < 0 || val > 255) {
        throw new Error('Array value must be within [0,255], but is: ' + val);
      }
      ta[i] = val;
    }
    return ta;
  }
  return {
    setters: [function (_) {
      _createClass = _['default'];
    }, function (_2) {
      _classCallCheck = _2['default'];
    }, function (_3) {
      _Math$trunc = _3['default'];
    }, function (_4) {
      _Symbol$iterator = _4['default'];
    }, function (_f) {
      _Map = _f['default'];
    }],
    execute: function () {
      /**
       * Calculates a linear palette of the given size (default 256) from the given
       * CSS color specifications.
       * 
       * Example:
       * <pre><code>
       * var grayscale = linearPalette(['#FFFFFF', '#000000'], 10) // 10-step palette
       * var rainbow = linearPalette(['#0000FF', '#00FFFF', '#00FF00', '#FFFF00', '#FF0000'])
       * </code></pre>
       * 
       * @param {Array} colors An array of CSS color specifications
       * @param {number} steps The number of palette colors to calculate
       * @return An object with members ncolors, red, green, blue, usable with
       *         the PaletteManager class.
       */
      'use strict';

      _export('linearPalette', linearPalette);

      _export('directPalette', directPalette);

      _export('scale', scale);

      PaletteManager = (function () {

        /**
         * @param {Integer} defaultSteps The default number of steps when adding palettes with addLinear().
         */

        function PaletteManager() {
          var _ref = arguments.length <= 0 || arguments[0] === undefined ? {} : arguments[0];

          var _ref$defaultSteps = _ref.defaultSteps;
          var defaultSteps = _ref$defaultSteps === undefined ? 256 : _ref$defaultSteps;

          _classCallCheck(this, PaletteManager);

          this._defaultSteps = defaultSteps;
          this._palettes = new _Map();
        }

        /**
         * Store a supplied generic palette under the given name.
         * 
         * @param name The unique name of the palette.
         * @param palette An object with red, green, and blue properties (each an array of [0,255] values),
         *                or an array of CSS color specifications.
         */

        _createClass(PaletteManager, [{
          key: 'add',
          value: function add(name, palette) {
            if (this._palettes.has(name)) {
              console.warn('A palette with name "' + name + '" already exists! Overwriting...');
            }
            if (Array.isArray(palette)) {
              palette = directPalette(palette);
            }

            if (![palette.red, palette.green, palette.blue].every(function (arr) {
              return arr.length === palette.red.length;
            })) {
              throw new Error('The red, green, blue arrays of the palette must be of equal lengths');
            }
            if (!(palette.red instanceof Uint8Array)) {
              palette.red = _asUint8Array(palette.red);
              palette.green = _asUint8Array(palette.green);
              palette.blue = _asUint8Array(palette.blue);
            }
            palette.steps = palette.red.length; // for convenience in clients
            this._palettes.set(name, palette);
          }

          /**
           * Store a linear palette under the given name created with the given CSS color specifications.
           * 
           * @param {String} name The unique name of the palette
           * @param {Array} colors An array of CSS color specifications
           * @param {Integer} steps Use a different number of steps than the default of this manager.
           */
        }, {
          key: 'addLinear',
          value: function addLinear(name, colors) {
            var _ref2 = arguments.length <= 2 || arguments[2] === undefined ? {} : arguments[2];

            var steps = _ref2.steps;

            this.add(name, linearPalette(colors, steps ? steps : this._defaultSteps));
          }

          /**
           * Return the palette stored under the given name, or throws an error if not found.
           * The palette is an object with properties steps, red, green, and blue.
           * Each of the color arrays is an Uint8Array of length steps.
           */
        }, {
          key: 'get',
          value: function get(name) {
            var palette = this._palettes.get(name);
            if (palette === undefined) {
              throw new Error('Palette "' + name + '" not found');
            }
            return palette;
          }
        }, {
          key: _Symbol$iterator,
          get: function get() {
            return this._palettes[_Symbol$iterator];
          }
        }]);

        return PaletteManager;
      })();

      _export('PaletteManager', PaletteManager);
    }
  };
});

$__System.register('d', ['1', '12', '13', '14', '15', '16', '18', '22', '23', '24', '25', '1e', '1f'], function (_export) {
  var L, _get, _inherits, _createClass, _classCallCheck, _slicedToArray, _Object$keys, wu, _Set, _Array$from, _Object$defineProperty, _getIterator, _Map, ParameterSync, SyncLayer;

  /**
   * Default function that checks if two Parameter objects describe
   * the same thing. No magic is applied here. Exact match or nothing.
   */
  function defaultMatch(p1, p2) {
    if (!p1.observedProperty.id || !p2.observedProperty.id) {
      return false;
    }
    if (p1.observedProperty.id !== p2.observedProperty.id) {
      return false;
    }
    if (p1.unit && p2.unit) {
      if (p1.unit.id && p2.unit.id && p1.unit.id !== p2.unit.id) {
        return false;
      }
      if (p1.unit.symbol && p2.unit.symbol && p1.unit.symbol !== p2.unit.symbol) {
        return false;
      }
    } else if (p1.unit || p2.unit) {
      // only one of both has units
      return false;
    }
    if (p1.categories && p2.categories) {
      if (p1.categories.length !== p2.categories.length) {
        return false;
      }
      var idMissing = function idMissing(cat) {
        return !cat.id;
      };
      if (p1.categories.some(idMissing) || p2.categories.some(idMissing)) {
        return false;
      }
      var _iteratorNormalCompletion = true;
      var _didIteratorError = false;
      var _iteratorError = undefined;

      try {
        var _loop = function () {
          var cat1 = _step.value;

          if (!p2.categories.some(function (cat2) {
            return cat1.id === cat2.id;
          })) {
            return {
              v: false
            };
          }
        };

        for (var _iterator = _getIterator(p1.categories), _step; !(_iteratorNormalCompletion = (_step = _iterator.next()).done); _iteratorNormalCompletion = true) {
          var _ret = _loop();

          if (typeof _ret === 'object') return _ret.v;
        }
      } catch (err) {
        _didIteratorError = true;
        _iteratorError = err;
      } finally {
        try {
          if (!_iteratorNormalCompletion && _iterator['return']) {
            _iterator['return']();
          }
        } finally {
          if (_didIteratorError) {
            throw _iteratorError;
          }
        }
      }
    } else if (p1.categories || p2.categories) {
      // only one of both has categories
      return false;
    }
    return true;
  }

  /**
   * Synchronizes visualization options of multiple renderer layers with matching Parameter
   * and exposes a combined view of those options in form of a virtual layer object.
   * 
   * A common use case for this is to have equal palettes and only a single legend
   * for multiple layers describing the same parameter.
   * 
   * Synchronizing visualization options means synchronizing certain common properties
   * of the layer instances. For example, the palette extents of two layers can be
   * synchronized by merging the extents of both. The logic for doing that has to
   * be specified in terms of binary functions supplied in the constructor.
   * 
   * By default, a simple algorithm determines if two Parameter objects are equivalent
   * by checking whether things like observedPropery have the same ID, units are the same,
   * etc. This default algorithm can be replaced with a custom one. Such a custom
   * algorithm could relate different vocabularies with each other or perform other checks.
   * 
   * @example <caption>Common palettes</caption>
   * let paramSync = new ParameterSync({
   *   syncProperties: {
   *     palette: (p1, p2) => p1,
   *     paletteExtent: (e1, e2) => e1 && e2 ? [Math.min(e1[0], e2[0]), Math.max(e1[1], e2[1])] : null
   *   }
   * }).on('parameterAdd', e => {
   *   // The virtual sync layer proxies the synced palette, paletteExtent, and parameter.
   *   // The sync layer will fire a 'remove' event once all real layers for that parameter were removed.
   *   let layer = e.syncLayer
   *   if (layer.palette) {
   *     new Legend(layer, {
   *       position: 'bottomright'
   *     }).addTo(map)
   *   }
   * })
   * let layer = layerFactory(cov).on('add', e => {
   *   // Only add the layer to the ParameterSync instance once it has initialized.
   *   // We can use the 'add' event for that.
   *   paramSync.addLayer(e.target)
   * })
   */
  return {
    setters: [function (_10) {
      L = _10['default'];
    }, function (_) {
      _get = _['default'];
    }, function (_2) {
      _inherits = _2['default'];
    }, function (_3) {
      _createClass = _3['default'];
    }, function (_4) {
      _classCallCheck = _4['default'];
    }, function (_5) {
      _slicedToArray = _5['default'];
    }, function (_8) {
      _Object$keys = _8['default'];
    }, function (_11) {
      wu = _11['default'];
    }, function (_6) {
      _Set = _6['default'];
    }, function (_7) {
      _Array$from = _7['default'];
    }, function (_9) {
      _Object$defineProperty = _9['default'];
    }, function (_e) {
      _getIterator = _e['default'];
    }, function (_f) {
      _Map = _f['default'];
    }],
    execute: function () {
      'use strict';

      ParameterSync = (function (_L$Class) {
        _inherits(ParameterSync, _L$Class);

        /**
         * @param {Object} options
         * @param {Object} options.syncProperties - 
         *   An object that defines which properties shall be synchronized and how.
         *   Each key is a property name where the value is a binary function that merges
         *   the values of two such properties.
         * @param {Function} [options.match] - 
         *   Custom function that checks if two Parameter objects shall be equivalent.
         *   The default function is simple and checks for identity of several properties.
         */

        function ParameterSync(options) {
          _classCallCheck(this, ParameterSync);

          _get(Object.getPrototypeOf(ParameterSync.prototype), 'constructor', this).call(this);
          this._syncProps = options.syncProperties || {};
          this._match = options.match || defaultMatch;
          this._paramLayers = new _Map(); // Map (Parameter -> Set(Layer))
          this._layerListeners = new _Map(); // Map (Layer -> Map(type -> listener))
          this._propSyncing = new _Set(); // Set (property name)
        }

        /**
         * Adds a layer that will be synchronized.
         * 
         * Synchronization stops automatically when the layer fires a 'remove' event.
         * 
         * @param {ILayer} layer - The layer to synchronize.
         * @fires ParameterSync#parameterAdd - When a layer with a new parameter was added.
         */

        _createClass(ParameterSync, [{
          key: 'addLayer',
          value: function addLayer(layer) {
            var _this = this;

            if (!layer.parameter) {
              console.log('layer has no parameter, skipping parameter sync');
              return;
            }
            var params = _Array$from(this._paramLayers.keys());
            var match = params.find(function (p) {
              return _this._match(p, layer.parameter);
            });

            var param = undefined;
            if (!match) {
              param = layer.parameter;
              this._paramLayers.set(param, new _Set([layer]));
            } else {
              param = match;
              this._paramLayers.get(param).add(layer);
              this._syncProperties(param);
            }

            this._registerLayerListeners(layer, param);

            if (!match) {
              /**
               * Parameter Add event.
               * 
               * @event ParameterSync#parameterAdd
               * @type {object}
               * @property {SyncLayer} syncLayer - 
               *   A virtual layer that proxies the synchronized properties for a single parameter.
               *   If all layers of that parameter are removed, this layer fires a 'remove' event,
               *   signalling that the parameter is not present anymore.
               */
              this.fire('parameterAdd', { syncLayer: new SyncLayer(param, this) });
            }
          }
        }, {
          key: '_removeLayer',
          value: function _removeLayer(layer, param) {
            var _iteratorNormalCompletion2 = true;
            var _didIteratorError2 = false;
            var _iteratorError2 = undefined;

            try {
              for (var _iterator2 = _getIterator(this._layerListeners.get(layer)), _step2; !(_iteratorNormalCompletion2 = (_step2 = _iterator2.next()).done); _iteratorNormalCompletion2 = true) {
                var _step2$value = _slicedToArray(_step2.value, 2);

                var type = _step2$value[0];
                var fn = _step2$value[1];

                layer.off(type, fn);
              }
            } catch (err) {
              _didIteratorError2 = true;
              _iteratorError2 = err;
            } finally {
              try {
                if (!_iteratorNormalCompletion2 && _iterator2['return']) {
                  _iterator2['return']();
                }
              } finally {
                if (_didIteratorError2) {
                  throw _iteratorError2;
                }
              }
            }

            this._layerListeners['delete'](layer);
            this._paramLayers.get(param)['delete'](layer);
            if (this._paramLayers.get(param).size === 0) {
              this._paramLayers['delete'](param);
              // underscore since the 'remove' event of the syncLayer should be used
              // from the outside
              this.fire('_parameterRemove', { param: param });
            }
          }
        }, {
          key: '_registerLayerListeners',
          value: function _registerLayerListeners(layer, param) {
            var _this2 = this;

            var listeners = new _Map([['remove', function () {
              return _this2._removeLayer(layer, param);
            }]]);
            var _iteratorNormalCompletion3 = true;
            var _didIteratorError3 = false;
            var _iteratorError3 = undefined;

            try {
              var _loop2 = function () {
                var prop = _step3.value;

                var type = prop + 'Change'; // our convention is camel case
                // TODO does it make sense to unify again, or should it just propagate unchanged?
                listeners.set(type, function () {
                  return _this2._syncProperty(param, prop);
                });
              };

              for (var _iterator3 = _getIterator(_Object$keys(this._syncProps)), _step3; !(_iteratorNormalCompletion3 = (_step3 = _iterator3.next()).done); _iteratorNormalCompletion3 = true) {
                _loop2();
              }
            } catch (err) {
              _didIteratorError3 = true;
              _iteratorError3 = err;
            } finally {
              try {
                if (!_iteratorNormalCompletion3 && _iterator3['return']) {
                  _iterator3['return']();
                }
              } finally {
                if (_didIteratorError3) {
                  throw _iteratorError3;
                }
              }
            }

            var _iteratorNormalCompletion4 = true;
            var _didIteratorError4 = false;
            var _iteratorError4 = undefined;

            try {
              for (var _iterator4 = _getIterator(listeners), _step4; !(_iteratorNormalCompletion4 = (_step4 = _iterator4.next()).done); _iteratorNormalCompletion4 = true) {
                var _step4$value = _slicedToArray(_step4.value, 2);

                var type = _step4$value[0];
                var fn = _step4$value[1];

                layer.on(type, fn);
              }
            } catch (err) {
              _didIteratorError4 = true;
              _iteratorError4 = err;
            } finally {
              try {
                if (!_iteratorNormalCompletion4 && _iterator4['return']) {
                  _iterator4['return']();
                }
              } finally {
                if (_didIteratorError4) {
                  throw _iteratorError4;
                }
              }
            }

            this._layerListeners.set(layer, listeners);
          }
        }, {
          key: '_syncProperties',
          value: function _syncProperties(param) {
            var _iteratorNormalCompletion5 = true;
            var _didIteratorError5 = false;
            var _iteratorError5 = undefined;

            try {
              for (var _iterator5 = _getIterator(_Object$keys(this._syncProps)), _step5; !(_iteratorNormalCompletion5 = (_step5 = _iterator5.next()).done); _iteratorNormalCompletion5 = true) {
                var prop = _step5.value;

                this._syncProperty(param, prop);
              }
            } catch (err) {
              _didIteratorError5 = true;
              _iteratorError5 = err;
            } finally {
              try {
                if (!_iteratorNormalCompletion5 && _iterator5['return']) {
                  _iterator5['return']();
                }
              } finally {
                if (_didIteratorError5) {
                  throw _iteratorError5;
                }
              }
            }
          }
        }, {
          key: '_syncProperty',
          value: function _syncProperty(param, prop) {
            if (this._propSyncing.has(prop)) {
              return;
            }
            var propreduce = this._syncProps[prop];
            var unified = wu(this._paramLayers.get(param)).map(function (l) {
              return l[prop];
            }).reduce(propreduce);
            // While we unify properties, stop listening for changes to prevent a cycle.
            this._propSyncing.add(prop);
            var _iteratorNormalCompletion6 = true;
            var _didIteratorError6 = false;
            var _iteratorError6 = undefined;

            try {
              for (var _iterator6 = _getIterator(this._paramLayers.get(param)), _step6; !(_iteratorNormalCompletion6 = (_step6 = _iterator6.next()).done); _iteratorNormalCompletion6 = true) {
                var layer_ = _step6.value;

                layer_[prop] = unified;
              }
            } catch (err) {
              _didIteratorError6 = true;
              _iteratorError6 = err;
            } finally {
              try {
                if (!_iteratorNormalCompletion6 && _iterator6['return']) {
                  _iterator6['return']();
                }
              } finally {
                if (_didIteratorError6) {
                  throw _iteratorError6;
                }
              }
            }

            this._propSyncing['delete'](prop);
            this.fire('_syncPropChange', { param: param, prop: prop });
          }
        }]);

        return ParameterSync;
      })(L.Class);

      ParameterSync.include(L.Mixin.Events);

      SyncLayer = (function (_L$Class2) {
        _inherits(SyncLayer, _L$Class2);

        function SyncLayer(param, paramSync) {
          var _this3 = this;

          _classCallCheck(this, SyncLayer);

          _get(Object.getPrototypeOf(SyncLayer.prototype), 'constructor', this).call(this);
          this._param = param;
          paramSync.on('_parameterRemove', function (e) {
            if (e.param === param) {
              _this3.fire('remove');
            }
          });
          paramSync.on('_syncPropChange', function (e) {
            if (e.param === param) {
              _this3.fire(e.prop + 'Change');
            }
          });
          var layers = function layers() {
            return paramSync._paramLayers.get(param);
          };
          var _iteratorNormalCompletion7 = true;
          var _didIteratorError7 = false;
          var _iteratorError7 = undefined;

          try {
            var _loop3 = function () {
              var prop = _step7.value;

              _Object$defineProperty(_this3, prop, {
                get: function get() {
                  return layers().values().next().value[prop];
                },
                set: function set(v) {
                  paramSync._propSyncing.add(prop);
                  var _iteratorNormalCompletion8 = true;
                  var _didIteratorError8 = false;
                  var _iteratorError8 = undefined;

                  try {
                    for (var _iterator8 = _getIterator(layers()), _step8; !(_iteratorNormalCompletion8 = (_step8 = _iterator8.next()).done); _iteratorNormalCompletion8 = true) {
                      var layer = _step8.value;

                      layer[prop] = v;
                    }
                  } catch (err) {
                    _didIteratorError8 = true;
                    _iteratorError8 = err;
                  } finally {
                    try {
                      if (!_iteratorNormalCompletion8 && _iterator8['return']) {
                        _iterator8['return']();
                      }
                    } finally {
                      if (_didIteratorError8) {
                        throw _iteratorError8;
                      }
                    }
                  }

                  paramSync._propSyncing['delete'](prop);
                  _this3.fire(prop + 'Change');
                },
                enumerable: true
              });
            };

            for (var _iterator7 = _getIterator(_Object$keys(paramSync._syncProps)), _step7; !(_iteratorNormalCompletion7 = (_step7 = _iterator7.next()).done); _iteratorNormalCompletion7 = true) {
              _loop3();
            }
          } catch (err) {
            _didIteratorError7 = true;
            _iteratorError7 = err;
          } finally {
            try {
              if (!_iteratorNormalCompletion7 && _iterator7['return']) {
                _iterator7['return']();
              }
            } finally {
              if (_didIteratorError7) {
                throw _iteratorError7;
              }
            }
          }
        }

        _createClass(SyncLayer, [{
          key: 'parameter',
          get: function get() {
            return this._param;
          }
        }]);

        return SyncLayer;
      })(L.Class);

      SyncLayer.include(L.Mixin.Events);

      // work-around for Babel bug, otherwise ParameterSync cannot be referenced above for mixins

      _export('default', ParameterSync);
    }
  };
});

$__System.register('e', ['1', '3', '11', '12', '13', '14', '15', '16', '17', '26', '1d', '1e'], function (_export) {
  var L, c3, i18n, _get, _inherits, _createClass, _classCallCheck, _slicedToArray, _defineProperty, _Promise, _getIterator, DEFAULT_PLOT_OPTIONS, ProfilePlot;

  return {
    setters: [function (_7) {
      L = _7['default'];
    }, function (_8) {
      c3 = _8['default'];
    }, function (_10) {
      i18n = _10;
    }, function (_) {
      _get = _['default'];
    }, function (_2) {
      _inherits = _2['default'];
    }, function (_3) {
      _createClass = _3['default'];
    }, function (_4) {
      _classCallCheck = _4['default'];
    }, function (_6) {
      _slicedToArray = _6['default'];
    }, function (_5) {
      _defineProperty = _5['default'];
    }, function (_9) {}, function (_d) {
      _Promise = _d['default'];
    }, function (_e) {
      _getIterator = _e['default'];
    }],
    execute: function () {

      // not used currently
      'use strict';

      DEFAULT_PLOT_OPTIONS = {};

      ProfilePlot = (function (_L$Popup) {
        _inherits(ProfilePlot, _L$Popup);

        function ProfilePlot(cov, options, plotOptions) {
          _classCallCheck(this, ProfilePlot);

          _get(Object.getPrototypeOf(ProfilePlot.prototype), 'constructor', this).call(this, { maxWidth: 350 });
          this._cov = cov;
          this.param = options.keys ? cov.parameters.get(options.keys[0]) : null;
          this.language = options.language || i18n.DEFAULT_LANGUAGE;
          this.plotOptions = plotOptions || DEFAULT_PLOT_OPTIONS;

          if (this.param === null) {
            throw new Error('multiple params not supported yet');
          }
        }

        _createClass(ProfilePlot, [{
          key: 'onAdd',
          value: function onAdd(map) {
            var _this = this;

            map.fire('dataloading');
            _Promise.all([this._cov.loadDomain(), this._cov.loadRanges()]).then(function (_ref) {
              var _ref2 = _slicedToArray(_ref, 2);

              var domain = _ref2[0];
              var ranges = _ref2[1];

              _this.domain = domain;
              _this.ranges = ranges;
              _this._addPlotToPopup();
              _get(Object.getPrototypeOf(ProfilePlot.prototype), 'onAdd', _this).call(_this, map);
              _this.fire('add');
              map.fire('dataload');
            })['catch'](function (e) {
              console.error(e);
              _this.fire('error', e);
              map.fire('dataload');
            });
          }
        }, {
          key: '_addPlotToPopup',
          value: function _addPlotToPopup() {
            // TODO transform if necessary
            var _domain = this.domain;
            var x = _domain.x;
            var y = _domain.y;

            this.setLatLng(L.latLng(y, x));
            var el = this._getPlotElement();
            this.setContent(el);
          }
        }, {
          key: '_getPlotElement',
          value: function _getPlotElement() {
            var param = this.param;

            var xLabel = 'Vertical';
            var unit = param.unit ? param.unit.symbol ? param.unit.symbol : i18n.getLanguageString(param.unit.label, this.language) : '';
            var obsPropLabel = i18n.getLanguageString(param.observedProperty.label, this.language);
            var x = ['x'];
            var _iteratorNormalCompletion = true;
            var _didIteratorError = false;
            var _iteratorError = undefined;

            try {
              for (var _iterator = _getIterator(this.domain.z), _step; !(_iteratorNormalCompletion = (_step = _iterator.next()).done); _iteratorNormalCompletion = true) {
                var z = _step.value;

                x.push(z);
              }
            } catch (err) {
              _didIteratorError = true;
              _iteratorError = err;
            } finally {
              try {
                if (!_iteratorNormalCompletion && _iterator['return']) {
                  _iterator['return']();
                }
              } finally {
                if (_didIteratorError) {
                  throw _iteratorError;
                }
              }
            }

            var y = [param.key];
            for (var i = 0; i < this.domain.z.length; i++) {
              y.push(this.ranges.get(param.key).values.get(i));
            }

            var el = document.createElement('div');
            c3.generate({
              bindto: el,
              data: {
                x: 'x',
                columns: [x, y],
                names: _defineProperty({}, param.key, obsPropLabel)
              },
              axis: {
                rotated: true,
                x: {
                  label: {
                    text: xLabel,
                    position: 'outer-center'
                  }
                },
                y: {
                  label: {
                    text: obsPropLabel + (unit ? ' (' + unit + ')' : ''),
                    position: 'outer-middle'
                  }
                }
              },
              grid: {
                x: {
                  show: true
                },
                y: {
                  show: true
                }
              },
              // no need for a legend since there is only one source currently
              legend: {
                show: false
              },
              tooltip: {
                format: {
                  title: function title(d) {
                    return 'Vertical: ' + d;
                  },
                  value: function value(_value, ratio, id) {
                    return _value + unit;
                  }
                }
              },
              zoom: {
                enabled: true,
                rescale: true
              },
              size: {
                height: 300,
                width: 350
              }
            });

            return el;
          }
        }]);

        return ProfilePlot;
      })(L.Popup);

      _export('default', ProfilePlot);
    }
  };
});

$__System.register('10', [], function (_export) {
  /**
   * Inject HTML and CSS into the DOM.
   * 
   * @param html The html to inject at the end of the body element.
   * @param css The CSS styles to inject at the end of the head element.
   */
  'use strict';

  _export('inject', inject);

  function inject(html, css) {
    // inject default template and CSS into DOM
    var span = document.createElement('span');
    span.innerHTML = html;
    document.body.appendChild(span.children[0]);

    if (css) {
      var style = document.createElement('style');
      style.type = 'text/css';
      if (style.styleSheet) {
        style.styleSheet.cssText = css;
      } else {
        style.appendChild(document.createTextNode(css));
      }
      document.head.appendChild(style);
    }
  }

  return {
    setters: [],
    execute: function () {}
  };
});

$__System.register('11', [], function (_export) {
  'use strict';

  var DEFAULT_LANGUAGE;

  _export('getLanguageTag', getLanguageTag);

  _export('getLanguageString', getLanguageString);

  function getLanguageTag(map) {
    var preferredLanguage = arguments.length <= 1 || arguments[1] === undefined ? DEFAULT_LANGUAGE : arguments[1];

    if (map.has(preferredLanguage)) {
      return preferredLanguage;
    } else {
      // could be more clever here for cases like 'de' vs 'de-DE'
      return map.keys().next().value;
    }
  }

  function getLanguageString(map) {
    var preferredLanguage = arguments.length <= 1 || arguments[1] === undefined ? DEFAULT_LANGUAGE : arguments[1];

    if (map.has(preferredLanguage)) {
      return map.get(preferredLanguage);
    } else {
      // random language
      // this case should not happen as all labels should have common languages
      return map.values().next().value;
    }
  }

  return {
    setters: [],
    execute: function () {
      DEFAULT_LANGUAGE = 'en';

      _export('DEFAULT_LANGUAGE', DEFAULT_LANGUAGE);
    }
  };
});

$__System.register('1a', ['14', '15', '19', '20'], function (_export) {
  var _createClass, _classCallCheck, ndarray, _Math$trunc, Wrapper1D;

  /***
   * Return the indices of the two neighbors in the a array closest to x.
   * The array must be sorted (strictly monotone), either ascending or descending.
   * 
   * If x exists in the array, both neighbors point to x.
   * If x is lower (greated if descending) than the first value, both neighbors point to 0.
   * If x is greater (lower if descending) than the last value, both neighbors point to the last index.
   * 
   * Adapted from https://stackoverflow.com/a/4431347
   */

  function indicesOfNearest(a, x) {
    if (a.length === 0) {
      throw new Error('Array must have at least one element');
    }
    var lo = -1;
    var hi = a.length;
    var ascending = a.length === 1 || a[0] < a[1];
    // we have two separate code paths to help the runtime optimize the loop
    if (ascending) {
      while (hi - lo > 1) {
        var mid = Math.round((lo + hi) / 2);
        if (a[mid] <= x) {
          lo = mid;
        } else {
          hi = mid;
        }
      }
    } else {
      while (hi - lo > 1) {
        var mid = Math.round((lo + hi) / 2);
        if (a[mid] >= x) {
          // here's the difference
          lo = mid;
        } else {
          hi = mid;
        }
      }
    }
    if (a[lo] === x) hi = lo;
    if (lo === -1) lo = hi;
    if (hi === a.length) hi = lo;
    return [lo, hi];
  }

  /**
   * Return the index in a of the value closest to x.
   * The array a must be sorted, either ascending or descending.
   * If x happens to be exactly between two values, the one that
   * appears first is returned.
   */

  function indexOfNearest(a, x) {
    var i = indicesOfNearest(a, x);
    var lo = i[0];
    var hi = i[1];
    if (Math.abs(x - a[lo]) <= Math.abs(x - a[hi])) {
      return lo;
    } else {
      return hi;
    }
  }

  /**
   * Wraps an object with get(i,j,k,...) method and .shape property
   * as a SciJS ndarray object (https://github.com/scijs/ndarray).
   * 
   * If the object happens to be a SciJS ndarray object already, then this function
   * just returns the same object.
   * 
   * Note that ndarray only accepts 1D-storage in its constructor, which means
   * we have to map our multi-dim indices to 1D, and get back to multi-dim
   * again afterwards.
   * TODO do benchmarks
   */

  function asSciJSndarray(arr) {
    if (['data', 'shape', 'stride', 'offset'].every(function (p) {
      return p in arr;
    })) {
      // by existence of these properties we assume it is an ndarray
      return arr;
    }
    var ndarr = ndarray(new Wrapper1D(arr), arr.shape);
    return ndarr;
  }

  /**
   * Wraps an ndarray-like object with get(i,j,...) method and .shape property
   * as a 1D array object with get(i) and .length properties.
   * Instances of this class can then be used as array storage for SciJS's ndarray. 
   */
  return {
    setters: [function (_) {
      _createClass = _['default'];
    }, function (_2) {
      _classCallCheck = _2['default'];
    }, function (_4) {
      ndarray = _4['default'];
    }, function (_3) {
      _Math$trunc = _3['default'];
    }],
    execute: function () {
      'use strict';

      _export('indicesOfNearest', indicesOfNearest);

      _export('indexOfNearest', indexOfNearest);

      _export('asSciJSndarray', asSciJSndarray);

      Wrapper1D = (function () {
        function Wrapper1D(arr) {
          _classCallCheck(this, Wrapper1D);

          this._arr = arr;
          this._shape = arr.shape;
          this._dims = arr.shape.length;
          this._calculateStrides();
          this.length = arr.shape.reduce(function (a, b) {
            return a * b;
          }, 1);
        }

        _createClass(Wrapper1D, [{
          key: '_calculateStrides',
          value: function _calculateStrides() {
            var strides = new Uint16Array(this._dims);
            strides[this._dims - 1] = 1;
            for (var i = this._dims - 2; i >= 0; i--) {
              strides[i] = strides[i + 1] * this._shape[i + 1];
            }
            this._strides = strides;
          }
        }, {
          key: 'get',
          value: function get(idx) {
            var _arr;

            // TODO add optimized versions for dim <= 4
            var dims = this._dims;
            var strides = this._strides;

            // convert 1D index to nd-indices
            var ndidx = new Array(dims);
            for (var i = 0; i < dims; i++) {
              ndidx[i] = _Math$trunc(idx / strides[i]);
              idx -= ndidx[i] * strides[i];
            }
            return (_arr = this._arr).get.apply(_arr, ndidx);
          }
        }]);

        return Wrapper1D;
      })();
    }
  };
});

$__System.register('1b', ['2e'], function (_export) {

  // handle null values in arrays
  // ndarray-ops only provides standard argmin and argmax

  /*eslint-disable */
  'use strict';

  var compile, nullargmin, nullargmax;
  function nullargminmax(op) {
    var minus = op === 'max' ? '-' : '';
    var comp = op === 'max' ? '>' : '<';

    // adapted from ndarray-ops argmin/argmax
    return compile({
      args: ["index", "array", "shape"],
      pre: {
        body: "{this_v=" + minus + "Infinity;this_i=_inline_0_arg2_.slice(0);for(var _inline_1_k=0;_inline_1_k<this_i.length;_inline_1_k++){this_i[_inline_1_k]=null}}",
        args: [{ name: "_inline_0_arg0_", lvalue: false, rvalue: false, count: 0 }, { name: "_inline_0_arg1_", lvalue: false, rvalue: false, count: 0 }, { name: "_inline_0_arg2_", lvalue: false, rvalue: true, count: 1 }],
        thisVars: ["this_i", "this_v"],
        localVars: [] },
      body: {
        body: "{if(_inline_1_arg1_ !== null && _inline_1_arg1_ " + comp + "this_v){this_v=_inline_1_arg1_;for(var _inline_1_k=0;_inline_1_k<_inline_1_arg0_.length;++_inline_1_k){this_i[_inline_1_k]=_inline_1_arg0_[_inline_1_k]}}}",
        args: [{ name: "_inline_1_arg0_", lvalue: false, rvalue: true, count: 2 }, { name: "_inline_1_arg1_", lvalue: false, rvalue: true, count: 2 }],
        thisVars: ["this_i", "this_v"],
        localVars: ["_inline_1_k"] },
      post: {
        body: "{return this_i[0] === null ? null : this_i}",
        args: [],
        thisVars: ["this_i"],
        localVars: [] }
    });
  }
  /*eslint-enable */

  return {
    setters: [function (_e) {
      compile = _e['default'];
    }],
    execute: function () {
      nullargmin = nullargminmax('min');

      _export('nullargmin', nullargmin);

      nullargmax = nullargminmax('max');

      _export('nullargmax', nullargmax);
    }
  };
});

$__System.register('26', [], false, function() {});
(function(c){if (typeof document == 'undefined') return; var d=document,a='appendChild',i='styleSheet',s=d.createElement('style');s.type='text/css';d.getElementsByTagName('head')[0][a](s);s[i]?s[i].cssText=c:s[a](d.createTextNode(c));})
(".c3 svg{font:10px sans-serif}.c3 line,.c3 path{fill:none;stroke:#000}.c3 text{-webkit-user-select:none;-moz-user-select:none;user-select:none}.c3-bars path,.c3-event-rect,.c3-legend-item-tile,.c3-xgrid-focus,.c3-ygrid{shape-rendering:crispEdges}.c3-chart-arc path{stroke:#fff}.c3-chart-arc text{fill:#fff;font-size:13px}.c3-grid line{stroke:#aaa}.c3-grid text{fill:#aaa}.c3-xgrid,.c3-ygrid{stroke-dasharray:3 3}.c3-text.c3-empty{fill:grey;font-size:2em}.c3-line{stroke-width:1px}.c3-circle._expanded_{stroke-width:1px;stroke:#fff}.c3-selected-circle{fill:#fff;stroke-width:2px}.c3-bar{stroke-width:0}.c3-bar._expanded_{fill-opacity:.75}.c3-target.c3-focused{opacity:1}.c3-target.c3-focused path.c3-line,.c3-target.c3-focused path.c3-step{stroke-width:2px}.c3-target.c3-defocused{opacity:.3!important}.c3-region{fill:#4682b4;fill-opacity:.1}.c3-brush .extent{fill-opacity:.1}.c3-legend-item{font-size:12px}.c3-legend-item-hidden{opacity:.15}.c3-legend-background{opacity:.75;fill:#fff;stroke:#d3d3d3;stroke-width:1}.c3-tooltip-container{z-index:10}.c3-tooltip{border-collapse:collapse;border-spacing:0;background-color:#fff;empty-cells:show;-webkit-box-shadow:7px 7px 12px -9px #777;-moz-box-shadow:7px 7px 12px -9px #777;box-shadow:7px 7px 12px -9px #777;opacity:.9}.c3-tooltip tr{border:1px solid #CCC}.c3-tooltip th{background-color:#aaa;font-size:14px;padding:2px 5px;text-align:left;color:#FFF}.c3-tooltip td{font-size:13px;padding:3px 6px;background-color:#fff;border-left:1px dotted #999}.c3-tooltip td>span{display:inline-block;width:10px;height:10px;margin-right:6px}.c3-tooltip td.value{text-align:right}.c3-area{stroke-width:0;opacity:.2}.c3-chart-arcs-title{dominant-baseline:middle;font-size:1.3em}.c3-chart-arcs .c3-chart-arcs-background{fill:#e0e0e0;stroke:none}.c3-chart-arcs .c3-chart-arcs-gauge-unit{fill:#000;font-size:16px}.c3-chart-arcs .c3-chart-arcs-gauge-max{fill:#777}.c3-chart-arcs .c3-chart-arcs-gauge-min{fill:#777}.c3-chart-arc .c3-gauge-value{fill:#000}");
})
(function(factory) {
  factory(L, L, L, L, L, L, L, L, L, c3);
});