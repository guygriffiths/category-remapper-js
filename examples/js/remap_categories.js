var MINI = require('minified');
var _ = MINI._,
    $ = MINI.$,
    $$ = MINI.$$,
    EE = MINI.EE,
    HTML = MINI.HTML;

var variable;
var coverage;
var toCats;
var map2, remappedLayer;

document.addEventListener('DOMContentLoaded', function () {
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

    //    var dataset = 'http://lovejoy.nerc-essc.ac.uk:8080/edal-json/api/datasets/MLC.nc/features/land_cover?details=domain,range,rangeMetadata';
    var dataset = 'http://localhost:8080/edal-json/api/datasets/MLC.nc/features/land_cover?details=domain,range,rangeMetadata';
    variable = 'land_cover';
    var toCategoriesUrl = 'modis-categories.json';

    var lcData;

    var requests = [];
    requests.push($.request('get', dataset).then(function (data) {
        lcData = $.parseJSON(data);
    }));

    requests.push($.request('get', toCategoriesUrl).then(function (data) {
        toCats = $.parseJSON(data);
    }));
    
    requests.push(CovJSON.read(lcData)).then(function (data) {
      coverage = cov;
    })

    var remap = new Remapper('remapper');

    Promise.all(requests).then(function () {        
        var LayerFactory = L.coverage.LayerFactory()

        lcLayer = LayerFactory(cov, {
            keys: [variable]
        });
        lcLayer.addTo(map);
        lcLayer.on('add', function () {
          var legend = new L.coverage.control.DiscreteLegend(lcLayer, {
            position: 'topright'
          }).addTo(map);
          
          var palette = lcLayer.palette;
          
          // we extract category colors from the palette leaflet-coverage generated
          // (leaflet-coverage reads preferred category colors from the coverage parameters)
          var categories = lcLayer.parameter.observedProperty.categories;
          var fromCats = [];
          for (var i=0; i < categories.length; i++) {
            var category = categories[i];
            fromCats.push({
              id: category.id,
              label: category.get('en'),
              color: 'rgb(' + palette.red[i] + ',' + palette.green[i] + ',' + palette.blue[i] + ')'
            })
          }
          
          remap.populateFroms(fromCats);
        });
        
        remap.populateTos(toCats);

        $$('#show_remapper').disabled = false;
        $$('#show_remapper').addEventListener('click', remap.show.bind(remap));
        
        // Get a JSON mapping from one category to the other.
        var mapping = 'melodies-modis-mapping.json';
        $.request('get', mapping).then(function (data) {
            remap.linkCategories($.parseJSON(data));
        });
    });

    remap.on('apply', function (data) {
        var mapping = data.mapping;
        console.log(mapping);
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
            tos2froms[mapping[change]].push(change);
        }

        var categories = [];
        for (i = 0; i < toCats.length; i++) {
            if (tos2froms[toCats[i].id]) {
                categories.push({
                    id: toCats[i].id,
                    preferredColor: toCats[i].color,
                    label: new Map([['en', toCats[i].label]])
                });
            }
        }

        var LayerFactory = L.coverage.LayerFactory();
        var remappedCov = L.coverage.transform.withCategories(coverage, variable, categories, mapping);
        remappedLayer = LayerFactory(remappedCov, {
            keys: [variable],
            // We explicitly force a palette as the "preferredColor" field
            // of the categories is just a preference and may be ignored.
            palette: getPaletteFromCategories(categories)
        });
        remappedLayer.addTo(map2);

        var legend = new L.coverage.control.DiscreteLegend(remappedLayer, {
            position: 'topright'
        }).addTo(map2);
    });

});

function getPaletteFromCategories(cats) {
    var i;
    var paletteArray = [];
    for (i = 0; i < cats.length; i++) {
        paletteArray.push(cats[i].preferredColor);
    }
    return L.coverage.palette.directPalette(paletteArray);
}
