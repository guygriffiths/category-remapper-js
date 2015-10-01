var populated = false;
var lc_layer;
var paletteArray;

$(document).ready(function () {
    // Set up map
    var map = L.map('map').setView([35, 0], 2);
    L.tileLayer('http://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: 'Map data &copy; <a href="http://www.osm.org">OpenStreetMap</a>',
        maxZoom: 18,
    }).addTo(map);

    $.getJSON('http://termite.nerc-essc.ac.uk:8080/edal-json/api/datasets/landcover.asc/features/land_cover?details=domain,range,rangeMetadata', null, function (data) {
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

    set_remap_function(function () {
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
    })
});

function show_remapper() {
    var fromData, toData;
    $('#remapper')[0].style.display = 'block';
    $.when(
        $.getJSON('modis-categories.json', function (data) {
            fromData = data.modis;
        }),
        $.getJSON('melodies-categories.json', function (data) {
            toData = data.melodies;
        })
    ).then(function () {
        populate(fromData, toData);
    });
};