var lc_layer, remapped_layer, coverage;
var dataset, variable, catData;
var populated = false;

$(document).ready(function () {
    // Set up maps
    var layer1 = L.tileLayer('http://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: 'Map data &copy; <a href="http://www.osm.org">OpenStreetMap</a>',
        maxZoom: 18
    });
    var layer2 = L.tileLayer('http://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: 'Map data &copy; <a href="http://www.osm.org">OpenStreetMap</a>',
        maxZoom: 18
    });

    var map = L.map('map', {
        layers: [layer1],
        center: [35, 0],
        zoom: 2
    });

    var map2 = L.map('map2', {
        layers: [layer2],
        center: [35, 0],
        zoom: 2,
        zoomControl: false
    });

    map.sync(map2);
    map2.sync(map);

    dataset = 'http://termite.nerc-essc.ac.uk:8080/edal-json/api/datasets/landcover.asc/features/land_cover?details=domain,range,rangeMetadata';
    variable = 'land_cover';
    var categories = 'modis-categories.json';

    var lcData, catMapping;
    $.when(
        $.getJSON(dataset, function (data) {
            lcData = data;
        }),
        $.getJSON(categories, function (data) {
            catData = data;
            catMapping = extractCategoryMapping(data);
        })
    ).then(function () {
        CovJSON.read(lcData).then(function (cov) {
            coverage = cov;
            var pal = getPaletteFromCategoryMapping(catMapping);
            var LayerFactory = L.coverage.LayerFactory()
            lc_layer = LayerFactory(cov, {
                keys: [variable],
                palette: pal
            });
            lc_layer.addTo(map);

            remapped_layer = LayerFactory(cov, {
                keys: [variable],
                palette: pal
            });
            remapped_layer.addTo(map2);
        });
    });
});

function extractCategoryMapping(catData) {
    var i;
    var val2color = {};
    var cats = catData.categories;

    // Build a map of value to colour
    for (i = 0; i < cats.length; i++) {
        val2color[cats[i].value] = cats[i].color;
    }

    return val2color;
}

function getPaletteFromCategoryMapping(catMapping) {
    var i;
    var min = Number.MAX_VALUE;
    var max = -Number.MAX_VALUE;

    // Find range of data
    for (key in catMapping) {
        min = Math.min(min, key);
        max = Math.max(max, key);
    }

    // Now create an array of all values from min to max of the mapped values
    var paletteArray = [];
    for (i = min; i <= max; i++) {
        if (i in catMapping) {
            paletteArray.push(catMapping[i]);
        } else {
            paletteArray.push('rgba(0,0,0,0)');
        }
    }
    return L.coverage.palette.directPalette(paletteArray);
}

function show_remapper() {
    remap(function (mapping) {
        var newCatMapping = $.extend(true, {}, extractCategoryMapping(catData));
        var changedVal;
        for (changedVal in mapping) {
            newCatMapping[changedVal] = mapping[changedVal];
        }
        remapped_layer.palette = getPaletteFromCategoryMapping(newCatMapping);
    });
    if (!populated) {
        populated = true;
        $.getJSON('melodies-categories.json', function (data) {
            populateFroms(catData.categories);
            populateTos(data.categories);
        })
    }
};