var populated = false;

// When document is ready, request categories
jsPlumb.bind("ready", function () {
    show_remapper();
});

show_remapper = function () {
    if (!populated) {
        $.getJSON('categories.json', null, populate);
        populated = true;
    }
    $('#remapper')[0].style.display = 'block';
    $('#blanket')[0].style.display = 'block';
};

$(window).resize(function () {
    jsPlumb.repaintEverything();
});

$('#submit-button').click(function () {
    var connectionMetadata = [];
    var connections = jsPlumb.select();
    connections.each(function (conn) {
        connectionMetadata.push({
            from: conn.endpoints[0].elementId,
            to: conn.endpoints[1].elementId
        })
    });
    alert(JSON.stringify(connectionMetadata, null, 4));
    $('#remapper')[0].style.display = 'none';
    $('#blanket')[0].style.display = 'none';
});

var populate = function (data) {
    var i;
    var froms = $('#froms');
    var tos = $('#tos');
    for (i = 0; i < data.from.length; i++) {
        froms.append('<div id="' + data.from[i].name + '" class="map-from">' + data.from[i].name + '</div>');

        jsPlumb.addEndpoint(data.from[i].name, {
            isSource: true,
            isTarget: false,
            endpoint: "Rectangle",
            paintStyle: {
                fillStyle: data.from[i].color,
                outlineColor: "black",
                outlineWidth: 1
            },
            anchor: "Right",
            maxConnections: 1,
            connectorOverlays: [["Arrow", {
                location: 0.2,
                paintStyle: {
                    fillStyle: data.from[i].color,
                    outlineColor: "black",
                    outlineWidth: 1
                },
                width: 15,
                length: 15
                }]]

        });

        jsPlumb.bind("click", function (conn) {
            jsPlumb.detach(conn);
        });
    }
    for (i = 0; i < data.to.length; i++) {
        console.log(data.to);
        tos.append('<div id="' + data.to[i].name + '" class="map-to">' + data.to[i].name + '</div>');
        jsPlumb.addEndpoint(data.to[i].name, {
            isSource: false,
            isTarget: true,
            endpoint: "Dot",
            paintStyle: {
                fillStyle: data.to[i].color,
                outlineColor: "black",
                outlineWidth: 1
            },
            anchor: "Left",
            maxConnections: data.from.length
        });
    }

}