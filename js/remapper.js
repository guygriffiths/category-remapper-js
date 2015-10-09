var remap_function = function () {
    window.alert('You need to set the behaviour after remapping')
};


$(window).resize(function () {
    jsPlumb.repaintEverything();
});

var remapperInitialised = false;

function init() {
    if (!remapperInitialised) {
        $('<div id="remapper" style="display:none"><div id="remap-froms"></div><div id="remap-tos"></div><div id="centrecontent"></div><div id="buttonholder"><button id="remap-button">Apply mapping</button></div></div>').appendTo(document.body);
        remapperInitialised = true;

        $('#remap-button').click(function () {
            var mapping = {};
            var connections = jsPlumb.select();
            connections.each(function (conn) {
                var fromValue = $(conn.endpoints[0].element).attr('value');
                var toValue = $(conn.endpoints[1].element).attr('value');
                mapping[fromValue] = parseInt(toValue);
            });

            $('#remapper')[0].style.display = 'none';
            remap_function(mapping);
        });
    }
}

function remap(f) {
    remap_function = f;
    $('#remapper')[0].style.display = 'block';
    jsPlumb.repaintEverything();
}

function populateFroms(fromCategories) {
    init();
    var i, id;
    $('#remap-froms').empty();
    $('#remapper')[0].style.display = 'block';
    for (i = 0; i < fromCategories.length; i++) {
        id = 'from:' + fromCategories[i].value;
        // Add a new div for each from category
        $('#remap-froms').append('<div id="' + id + '" class="map-from" ' +
            ' color="' + fromCategories[i].color + '" ' +
            'value="' + fromCategories[i].value + '" ' +
            '>' + fromCategories[i].label.get("en") + '</div>');

        // Now add the jsPlumb endpoint
        jsPlumb.addEndpoint(id, {
            container: $('#remapper'),
            uuid: id,
            isSource: true,
            isTarget: false,
            endpoint: "Rectangle",
            paintStyle: {
                fillStyle: fromCategories[i].color,
                outlineColor: "black",
                outlineWidth: 1
            },
            anchor: "Right",
            maxConnections: 1,
            connectorOverlays: [["PlainArrow", {
                location: 0.2,
                paintStyle: {
                    fillStyle: fromCategories[i].color,
                    outlineColor: "black",
                    outlineWidth: 1
                },
                width: 15,
                length: 15
                }]]
        });
    }
    $('#remapper')[0].style.display = 'none';

    // Clicking the arrow should remove the mapping
    jsPlumb.bind("click", function (conn) {
        jsPlumb.detach(conn);
    });
}

function populateTos(toCategories) {
    init();
    var i, id;
    $('#remap-tos').empty();
    $('#remapper')[0].style.display = 'block';
    for (i = 0; i < toCategories.length; i++) {
        // Repeat the procedure for the to categories
        id = 'to:' + toCategories[i].value;
        $('#remap-tos').append('<div id="' + id + '" class="map-to"' +
            ' color="' + toCategories[i].color + '" ' +
            'value="' + toCategories[i].value + '" ' +
            '> ' + toCategories[i].label.get("en") + ' </div>');
        jsPlumb.addEndpoint(id, {
            container: $('#remapper'),
            uuid: id,
            isSource: false,
            isTarget: true,
            endpoint: "Dot",
            paintStyle: {
                fillStyle: toCategories[i].color,
                outlineColor: "black",
                outlineWidth: 1
            },
            anchor: "Left",
            maxConnections: $('.map-from').length
        });
    }
    $('#remapper')[0].style.display = 'none';
}