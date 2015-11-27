var MINI = require('minified');
var _ = MINI._,
    $ = MINI.$,
    $$ = MINI.$$,
    EE = MINI.EE,
    HTML = MINI.HTML;

var remap_function = function () {
    window.alert('You need to set the post-remapping behaviour')
};

window.addEventListener('resize', function () {
    jsPlumb.repaintEverything();
});

/**
 * Populate the remapper element if it is empty.  This method must be called prior to 
 * populating the from/to categories but since these are permitted to be called in any 
 * order, we cannot guarantee that this method only gets called once.
 */
function init() {
    if (!$$('#remapper').innerHTML) {
        $$('#remapper').innerHTML = '<div id="remap-froms"></div><div id="remap-tos"></div><div id="centrecontent"></div><div id="buttonholder"><button id="remap-button">Apply mapping</button></div>';
        $$('#remapper').style.display = 'none';

        $$('#remap-button').addEventListener('click', function () {
            // Once the "Apply mapping" button is clicked, we retrieve the current state 
            // of the mapping, store it in an object and pass it to the remap_function
            var mapping = {};
            var connections = jsPlumb.select();
            connections.each(function (conn) {
                console.log(conn);
                var fromValue = $$(conn.endpoints[0].element).getAttribute('value');
                var toValue = $$(conn.endpoints[1].element).getAttribute('value');
                mapping[fromValue] = parseInt(toValue);
            });

            $$('#remapper').style.display = 'none';
            remap_function(mapping);
        });
    }
}

/**
 * Display the category remapper ready to apply a remapping.
 * @param {function} f The function to be called once the "Apply mapping" button is 
 *                     clicked.  Should take a single object which maps integer 
 *                     categories to other integer categories.
 */
function remap(f) {
    remap_function = f;
    $$('#remapper').style.display = 'block';
    jsPlumb.repaintEverything();
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
function populateFroms(fromCategories) {
    init();
    var i, id;
    $$('#remapper').style.display = 'block';
    $$('#remap-froms').innerHTML = '';
    for (i = 0; i < fromCategories.length; i++) {
        id = 'from:' + fromCategories[i].value;
        // Add a new div for each from category
        $$('#remap-froms').innerHTML += '<div id="' + id + '" class="map-from" ' +
            ' color="' + fromCategories[i].color + '" ' +
            'value="' + fromCategories[i].value + '" ' +
            '>' + fromCategories[i].label.get("en") + '</div>';
    }

    // Should be able to combine this loop with the one above.
    // When we were using jQuery it worked like that.  Now it doesn't...
    //
    // I don't know why.  It doesn't make any sense.
    for (i = 0; i < fromCategories.length; i++) {
        id = 'from:' + fromCategories[i].value;

        // Now add the jsPlumb endpoint
        jsPlumb.addEndpoint(id, {
            container: $$('#remapper'),
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
    $$('#remapper').style.display = 'none';

    // Clicking the arrow should remove the mapping
    jsPlumb.bind('click', function (conn) {
        jsPlumb.detach(conn);
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
function populateTos(toCategories) {
    init();
    var i, id;
    $$('#remap-tos').innerHTML = '';
    $$('#remapper').style.display = 'block';
    for (i = 0; i < toCategories.length; i++) {
        // Repeat the procedure for the to categories
        id = 'to:' + toCategories[i].value;
        $$('#remap-tos').innerHTML += '<div id="' + id + '" class="map-to"' +
            ' color="' + toCategories[i].color + '" ' +
            'value="' + toCategories[i].value + '" ' +
            '> ' + toCategories[i].label.get("en") + ' </div>';
    }

    // Should be able to combine this loop with the one above.
    // When we were using jQuery it worked like that.  Now it doesn't...
    //
    // I don't know why.  It doesn't make any sense.
    for (i = 0; i < toCategories.length; i++) {
        id = 'to:' + toCategories[i].value;
        jsPlumb.addEndpoint(id, {
            container: $('#remapper'),
            uuid: id,
            isSource: false,
            isTarget: true,
            endpoint: 'Dot',
            paintStyle: {
                fillStyle: toCategories[i].color,
                outlineColor: 'black',
                outlineWidth: 1
            },
            anchor: 'Left',
            maxConnections: $('.map-from').length
        });
    }
    $$('#remapper').style.display = 'none';
}

/**
 * Extracts the categories as coverage-json compatible objects from the simple JSON 
 * representation
 * @param   {object} catData The JSON representation of the categories
 * @returns {object} The object with the language mappings taken care of properly
 */
function extractCoverageCategories(catData) {
    catData = catData.categories;
    var categories = [];
    var i, j;
    for (i = 0; i < catData.length; i++) {
        var labelMap = new Map();
        for (j = 0; j < catData[i].label.length; j++) {
            labelMap.set(catData[i].label[j][0], catData[i].label[j][1]);
        }
        categories.push({
            label: labelMap,
            value: catData[i].value,
            color: catData[i].color
        });
    }
    return categories;
}

/**
 * Applys a mapping from one set of categories to another
 * @param {object} mapping An object whose keys are the integer categories to map from 
 *                         and whose values are the integer categories to map to.
 */
function linkCategories(mapping) {
    var tovals, i;
    for (fromVal in mapping) {
        jsPlumb.connect({
            uuids: ['from:' + fromVal, 'to:' + mapping[fromVal]]
        });
    }
}