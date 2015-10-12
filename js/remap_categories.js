var variable;
var coverage;
var fromCats, toCats;
var map2, remappedLayer;

$(document).ready(function () {
    //    $('<div id="remapper" style="display:none"><div id="remap-froms"></div><div id="remap-tos"></div><div id="centrecontent"></div><div id="buttonholder"><button id="remap-button">Apply mapping</button></div></div>').appendTo(document.body);
    init();
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
        center: [55, -3.5],
        zoom: 6
    });

    map2 = L.map('map2', {
        layers: [layer2],
        center: [55, -3.5],
        zoom: 6,
        zoomControl: false
    });

    map.sync(map2);
    map2.sync(map);

    var dataset = 'http://lovejoy.nerc-essc.ac.uk:8080/edal-json/api/datasets/MLC.nc/features/land_cover?details=domain,range,rangeMetadata';
    //    dataset = 'http://localhost:8080/edal-json/api/datasets/MLC.nc/features/land_cover?details=domain,range,rangeMetadata';
    variable = 'land_cover';
    //    var categories = 'modis-categories.json';
    var fromCategoriesUrl = 'melodies-categories.json';
    var toCategoriesUrl = 'modis-categories.json';

    var lcData, fromId, toId;
    $.when(
        $.getJSON(dataset, function (data) {
            lcData = data;
        }),
        $.getJSON(fromCategoriesUrl, function (data) {
            fromCats = getCoverageCategories(data.categories);
            fromId = data.id;
            populateFroms(fromCats);
        }),
        $.getJSON(toCategoriesUrl, function (data) {
            toCats = getCoverageCategories(data.categories);
            toId = data.id;
            populateTos(toCats);
        })
    ).then(function () {
        CovJSON.read(lcData).then(function (cov) {
            var LayerFactory = L.coverage.LayerFactory()
            coverage = cov;

            coverage.parameters.get('land_cover').categories = fromCats;
            coverage.parameters.get('land_cover').observedProperty = {
                label: new Map([["en", "Land Cover"]])
            };

            lcLayer = LayerFactory(cov, {
                keys: [variable],
                palette: getPaletteFromCategories(fromCats)
            });
            lcLayer.addTo(map);

            var legend = new L.coverage.control.DiscreteLegend(lcLayer, {
                position: 'topright'
            }).addTo(map);
        });

        // Try and get a JSON mapping from one category to the other.
        // If it doesn't exist, this will silently fail
        var mapping = fromId + '-' + toId + '-mapping.json';
        $.getJSON(mapping, function (mapping) {
            linkCategories(mapping);
            $('#show_remapper').click(show_remapper);
        })
    });
});

function getCoverageCategories(catData) {
    var categories = [];
    var i;
    for (i = 0; i < catData.length; i++) {
        categories.push({
            label: new Map([["en", catData[i].label]]),
            value: catData[i].value,
            color: catData[i].color
        });
    }
    return categories;
}

function getPaletteFromCategories(cats) {
    var i;
    var paletteArray = [];
    for (i = 0; i < cats.length; i++) {
        paletteArray.push(cats[i].color);
    }
    return L.coverage.palette.directPalette(paletteArray);
}

function show_remapper() {
    remap(function (mapping) {
        if (remappedLayer) {
            map2.removeLayer(remappedLayer);
        }

        var i;
        var tos2froms = {};
        var change;
        for (change in mapping) {
            if (!tos2froms[mapping[change]]) {
                tos2froms[mapping[change]] = [];
            }
            tos2froms[mapping[change]].push(parseInt(change));
        }

        var categories = [];
        for (i = 0; i < toCats.length; i++) {
            if (tos2froms[toCats[i].value]) {
                categories.push({
                    label: toCats[i].label,
                    values: tos2froms[i],
                    color: toCats[i].color
                });
            }
        }

        var LayerFactory = L.coverage.LayerFactory()
        var remappedCov = L.coverage.transform.withCategories(coverage, variable, categories);
        remappedLayer = LayerFactory(remappedCov, {
            keys: [variable],
            palette: getPaletteFromCategories(categories)
        });
        remappedLayer.addTo(map2);

        var legend = new L.coverage.control.DiscreteLegend(remappedLayer, {
            position: 'topright'
        }).addTo(map2);
    });
};