var populated = false;
var lc_layer;
var paletteArray;

$(document).ready(function () {

    var map = L.map('map').setView([35, 0], 2);
    //    var map = L.map('map').setView([51.45, -0.97], 15);

    L.tileLayer('https://api.tiles.mapbox.com/v4/{id}/{z}/{x}/{y}.png?access_token={accessToken}', {
        attribution: 'Map data &copy; <a href="http://openstreetmap.org">OpenStreetMap</a> contributors, <a href="http://creativecommons.org/licenses/by-sa/2.0/">CC-BY-SA</a>, Imagery © <a href="http://mapbox.com">Mapbox</a>',
        maxZoom: 18,
        id: 'guygriffiths.d257bb70',
        accessToken: 'pk.eyJ1IjoiZ3V5Z3JpZmZpdGhzIiwiYSI6ImE5NmNjMjM0YWJlNGE0YTgxMWQ3NjBiMzhjOGIxZjQzIn0.pEyg9tM6EC9l-1Qiso0QgQ'
    }).addTo(map);


    //    $.getJSON('grid.covjson', null, function (data) {
    $.getJSON('http://termite.nerc-essc.ac.uk:8080/edal-json/api/datasets/landcover.asc/features/land_cover?details=domain,range,rangeMetadata', null, function (data) {
        console.log("got json", data);
        CovJSON.read(data).then(function (cov) {
            var LayerFactory = L.coverage.LayerFactory()
            lc_layer = LayerFactory(cov, {
                keys: ['land_cover']
            });
            lc_layer.addTo(map);

            paletteArray = ['#000080',
'#008000',
'#00FF00',
'#99CC00',
'#99FF99',
'#339966',
'#993366',
'#FFCC99',
'#CCFFCC',
'#FFCC00',
'#FF9900',
'#006699',
'#FFFF00',
'#FF0000',
'#999966',
'#FFFFFF',
'#808080'];
            var pal = L.coverage.palette.directPalette(paletteArray);
            lc_layer.palette = pal;
        })
    });
});

show_remapper = function () {
    if (!populated) {
        $.getJSON('categories.json', null, populate);
        populated = true;
    }
    $('#remapper')[0].style.display = 'block';
};

$(window).resize(function () {
    jsPlumb.repaintEverything();
});

$('#remap-button').click(function () {
    var connectionMetadata = [];
    var connections = jsPlumb.select();
    connections.each(function (conn) {
        var fromColor = $(conn.endpoints[0].element).attr('color');
        var toColor = $(conn.endpoints[1].element).attr('color');
        for (var i = 0; i < paletteArray.length; i++) {
            if (paletteArray[i] === fromColor) {
                paletteArray[i] = toColor;
            }
        }
        lc_layer.palette = L.coverage.palette.directPalette(paletteArray);;
    });
    $('#remapper')[0].style.display = 'none';
});

var populate = function (data) {
    var i;
    var id;
    var froms = $('#froms');
    var tos = $('#tos');
    for (i = 0; i < data.from.length; i++) {
        id = 'from:' + data.from[i].name;
        froms.append('<div id="' + id + '" class="map-from" ' +
            ' color="' + data.from[i].color + '" ' +
            //                     ' style="height: ' + 90 / data.from.length + '%"'+
            '>' + data.from[i].name + '</div>');

        jsPlumb.addEndpoint(id, {
            uuid: id,
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
        id = 'to:' + data.to[i].name;
        tos.append('<div id="' + id + '" class="map-to"' +
            ' color="' + data.to[i].color + '" ' +
            '> ' + data.to[i].name + ' </div>');
        jsPlumb.addEndpoint(id, {
            uuid: id,
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

    var nConnections = Math.min(data.to.length, data.from.length);
    for (i = 0; i < nConnections; i++) {
        jsPlumb.connect({
            uuids: ['from:' + data.from[i].name,
            'to:' + data.to[i].name]
        });
    }
}