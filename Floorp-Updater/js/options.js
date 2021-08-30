var $ = function(sel){return document.getElementById(sel)}; //jquery id selector



// Saves options to chrome.storage
function save_options() {
  	var updateStartup = ($('updateStartup').checked)? true : false;
  	var updateHourly = ($('updateHourly').checked)? true : false;
	//var officialStable = ($('officialStable').checked)? true : false;
 // 	var stableMismatch = ($('stableMismatch').checked)? true : false;
	chrome.storage.sync.set({
		updateStartup: updateStartup,
		updateHourly: updateHourly
	//	officialStable: officialStable,
	//	stableMismatch: stableMismatch
  }, function() {
  	if (updateHourly) { 
  		chrome.extension.getBackgroundPage().updateHourly = true;
  		chrome.extension.getBackgroundPage().hourlyUpdate();
  	}
  	else {
  		chrome.extension.getBackgroundPage().updateHourly = false;
  	}
    // 	var status = $('status');
    // 	status.style.fontSize = "10pt";
    // 	status.style.color = "#99ccff";
    // 	status.textContent = 'saved';
    // 	setTimeout(function() {
    //   	status.textContent = '';
    // }, 1000);
  });
}

function restore_options() {
  chrome.storage.sync.get({
		updateStartup: true,
		updateHourly: false
	
  }, function(items) {
    $('updateStartup').checked = items.updateStartup;
	$('updateHourly').checked = items.updateHourly;
	
  });
}
document.addEventListener('DOMContentLoaded', restore_options);
options = document.getElementsByTagName('input');
for (i=0;i<options.length;i++) {
	options[i].addEventListener('click', save_options);
}

