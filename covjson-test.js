$(document).ready(function () {
    console.log("ready!");
    $.getJSON('profile.covjson', null, read_data);
});

var read_data = function (data) {
    CovJSON.read(data).then(function (cov) {
        console.log(cov);
        console.log(Object.keys(cov));
        console.log(Object.keys(cov._params));
    });
}