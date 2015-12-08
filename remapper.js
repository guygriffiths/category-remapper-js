(function (root, factory) {
    if (typeof define === 'function' && define.amd) {
        // AMD. Register as an anonymous module.
        define(['jsPlumb'], factory);
    } else {
        // Browser globals
        root.Remapper = factory(root.jsPlumb);
    }
}(this, function (jsPlumb) {

/**
 * Returns the first child element of parent (fall-back to document if not given)
 * matching the given selector.
 */
function $$ (selector, parent) {
  if (typeof parent === 'string') {
    parent = $$(parent);
  }
  parent = parent || document;
  return parent.querySelector(selector);
}

function Remapper(id, buttonLabel) {
    if (!buttonLabel) {
        buttonLabel = "Apply mapping";
    }

    this.id = id;
    this._init(buttonLabel);

    this.listeners = new Map();
}

Remapper.prototype.on = function (name, fn) {
    if (!this.listeners.has(name)) {
        this.listeners[name] = new Set();
    }
    this.listeners[name].add(fn);
}

Remapper.prototype.off = function (name, fn) {
    this.listeners[name].delete(fn);
}

Remapper.prototype.fire = function (name, obj) {
    this.listeners[name].forEach(function (fn) {
      fn(obj);
    })
}


/**
 * Populate the remapper element if it is empty.  This method must be called prior to 
 * populating the from/to categories but since these are permitted to be called in any 
 * order, we cannot guarantee that this method only gets called once.
 */
Remapper.prototype._init = function (buttonLabel) {
    this.jsPlumb = jsPlumb.getInstance();

    var self = this;
    if (!$$('#' + self.id).innerHTML) {
        $$('#' + self.id).innerHTML = '<div class="remap-froms"></div><div class="remap-tos"></div><div class="centrecontent"></div><div class="buttonholder"><button class="remap-button">' + buttonLabel + '</button></div>';
        $$('#' + self.id).style.display = 'none';
        $$('#' + self.id).className += 'main-remapper';

        $$('.remap-button', '#' + self.id).addEventListener('click', function () {
            // Once the "Apply mapping" button is clicked, we retrieve the current state 
            // of the mapping, store it in an object and pass it to the remap_function
            var mapping = {};
            var connections = self.jsPlumb.select();
            connections.each(function (conn) {
                var fromValue = $$(conn.endpoints[0].element).getAttribute('data-categoryId');
                var toValue = $$(conn.endpoints[1].element).getAttribute('data-categoryId');
                mapping[fromValue] = toValue;
            });

            $$('#' + self.id).style.display = 'none';
            self.fire('apply', {
                mapping: mapping
            });
        });
    }

    this._resize = function () {
        self.jsPlumb.repaintEverything();
    };
    window.addEventListener('resize', this._resize);
}

Remapper.prototype.remove = function () {
    window.removeEventListener('resize', this._resize);
    document.removeChild($$('#' + self.id));
}


/**
 * Display the category remapper ready to apply a remapping.
 */
Remapper.prototype.show = function () {
    $$('#' + this.id).style.display = 'block';
    this.jsPlumb.repaintEverything();
}

/**
 * Populate the list of categories to map from
 * @param {object} fromCategories An object with two values: 
 *                      "id" - the ID of the category set; 
 *                      "categories" - an array of objects with 3 values each:
 *                          "label" - A Map of language codes to the label of the 
 *                                    category in that language;
 *                          "value" - the numerical value of that category;   
 *                          "color" - A CSS color to use when plotting the category.
 *                      The categories object is the same type of object used to define 
 *                      categories in the coverage-json library.
 */
Remapper.prototype.populateFroms = function (fromCategories) {
    var i, id;

    var self = this;
    $$('#' + self.id).style.display = 'block';
    $$('.remap-froms', '#' + self.id).innerHTML = '';
    for (i = 0; i < fromCategories.length; i++) {
        id = 'from:' + fromCategories[i].id;
        // Add a new div for each from category
        $$('.remap-froms', '#' + self.id).innerHTML += '<div id="' + id + '" class="map-from" ' +
            ' color="' + fromCategories[i].color + '" ' +
            'data-categoryId="' + fromCategories[i].id + '" ' +
            '>' + fromCategories[i].label + '</div>';
    }

    // Should be able to combine this loop with the one above.
    // When we were using jQuery it worked like that.  Now it doesn't...
    //
    // I don't know why.  It doesn't make any sense.
    for (i = 0; i < fromCategories.length; i++) {
        id = 'from:' + fromCategories[i].id;
        // Now add the jsPlumb endpoint
        self.jsPlumb.addEndpoint(id, {
            container: $$('#' + self.id),
            uuid: id,
            isSource: true,
            isTarget: false,
            endpoint: 'Rectangle',
            paintStyle: {
                fillStyle: fromCategories[i].color,
                outlineColor: 'black',
                outlineWidth: 1
            },
            anchor: 'Right',
            maxConnections: 1,
            connectorOverlays: [['PlainArrow', {
                location: 0.2,
                paintStyle: {
                    fillStyle: fromCategories[i].color,
                    outlineColor: 'black',
                    outlineWidth: 1
                },
                width: 15,
                length: 15
                }]]
        });
    }
    $$('#' + self.id).style.display = 'none';

    // Clicking the arrow should remove the mapping
    self.jsPlumb.bind('click', function (conn) {
        self.jsPlumb.detach(conn);
    });
}

/**
 * Populate the list of categories to map to
 * @param {object} toCategories An object with two values: 
 *                      "id" - the ID of the category set; 
 *                      "categories" - an array of objects with 3 values each:
 *                          "label" - A Map of language codes to the label of the 
 *                                    category in that language;
 *                          "value" - the numerical value of that category;   
 *                          "color" - A CSS color to use when plotting the category.
 *                      The categories object is the same type of object used to define 
 *                      categories in the coverage-json library.
 */
Remapper.prototype.populateTos = function (toCategories) {
    var i, id;
    var self = this;
    $$('.remap-tos', '#' + this.id).innerHTML = '';
    $$('#' + self.id).style.display = 'block';
    for (i = 0; i < toCategories.length; i++) {
        // Repeat the procedure for the to categories
        id = 'to:' + toCategories[i].id;
        $$('.remap-tos', '#' + this.id).innerHTML += '<div id="' + id + '" class="map-to"' +
            ' color="' + toCategories[i].color + '" ' +
            'data-categoryId="' + toCategories[i].id + '" ' +
            '> ' + toCategories[i].label + ' </div>';
    }

    // Should be able to combine this loop with the one above.
    // When we were using jQuery it worked like that.  Now it doesn't...
    //
    // I don't know why.  It doesn't make any sense.
    for (i = 0; i < toCategories.length; i++) {
        id = 'to:' + toCategories[i].id;
        this.jsPlumb.addEndpoint(id, {
            container: $$('#' + self.id),
            uuid: id,
            isSource: false,
            isTarget: true,
            endpoint: 'Dot',
            paintStyle: {
                fillStyle: toCategories[i].color,
                outlineColor: 'black',
                outlineWidth: 1
            },
            anchor: 'Left'
        });
    }
    $$('#' + self.id).style.display = 'none';
}

/**
 * Applys a mapping from one set of categories to another
 * @param {object} mapping An object whose keys are the integer categories to map from 
 *                         and whose values are the integer categories to map to.
 */
Remapper.prototype.linkCategories = function (mapping) {
    var tovals, i;
    for (fromVal in mapping) {
        this.jsPlumb.connect({
            uuids: ['from:' + fromVal, 'to:' + mapping[fromVal]]
        });
    }
}

return Remapper;
}));