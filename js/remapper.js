var remap_function = function () {
    window.alert('You need to set the behaviour after remapping')
};

$(document).ready(function () {
    $('<div id="remapper" style="display:none"><div id="remap-froms"></div><div id="remap-tos"></div><div id="centrecontent"></div><div id="buttonholder"><button id="remap-button">Apply mapping</button></div></div>').appendTo(document.body);
    $('#remap-button').click(function () {
        remap_function();
        $('#remapper')[0].style.display = 'none';
    });
});

$(window).resize(function () {
    jsPlumb.repaintEverything();
});

function set_remap_function(f) {
    remap_function = f;
}

function populate(fromCategories, toCategories) {
    // Empty the divs ready to be populated
    $('#remap-froms').empty();
    $('#remap-tos').empty();

    var i;
    var id;
    for (i = 0; i < fromCategories.length; i++) {
        id = 'from:' + fromCategories[i].value;
        // Add a new div for each from category
        $('#remap-froms').append('<div id="' + id + '" class="map-from" ' +
            ' color="' + fromCategories[i].color + '" ' +
            //                     ' style="height: ' + 90 / fromCategories.length + '%"'+
            '>' + fromCategories[i].name + '</div>');

        // Now add the jsPlumb endpoint
        jsPlumb.addEndpoint(id, {
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
            connectorOverlays: [["Arrow", {
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
    for (i = 0; i < toCategories.length; i++) {
        // Repeat the procedure for the to categories
        id = 'to:' + toCategories[i].value;
        $('#remap-tos').append('<div id="' + id + '" class="map-to"' +
            ' color="' + toCategories[i].color + '" ' +
            '> ' + toCategories[i].name + ' </div>');
        jsPlumb.addEndpoint(id, {
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
            maxConnections: fromCategories.length
        });
    }

    // Clicking the arrow should remove the mapping
    jsPlumb.bind("click", function (conn) {
        jsPlumb.detach(conn);
    });

    // Start by mapping top to bottom.  This may want to be removed later
    var nConnections = Math.min(toCategories.length, fromCategories.length);
    for (i = 0; i < nConnections; i++) {
        jsPlumb.connect({
            uuids: ['from:' + fromCategories[i].value,
                'to:' + toCategories[i].value]
        });
    }

}