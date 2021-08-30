/*
Iron Updater by SRWare

Based on 
Chromium Updater by stullig 
*/


var $ = document.getElementById.bind(document);
var latestStable, latestIronStable, downloadURL;
var updateStartup, updateHourly, officialStable, stableMismatch;
var currentVer = window.navigator.userAgent.match(/Chrome\/([\d.]+)/)[1];

chrome.storage.sync.get(['updateStartup', 'updateHourly'], function(items)
  {
       updateStartup = (items.updateStartup != undefined) ? items.updateStartup : true;
       updateHourly = (items.updateHourly != undefined) ? items.updateHourly : false;
       //officialStable = (items.officialStable != undefined) ? items.officialStable : false;
       //stableMismatch = (items.stableMismatch != undefined) ? items.stableMismatch : false;
       init();

  });

chrome.extension.onRequest.addListener(function(request, sender, sendResponse) {
  if (request.method == "getLocalStorage")
      sendResponse({data: localStorage[request.key]});
  if (request.method == "setLocalStorage") {
    localStorage[request.key] = request.content;
    sendResponse({});
  }
  else {
    sendResponse({}); // snub them.
  }
});


function init() {
  if (updateHourly) {
    hourlyUpdate();
  }
  if (updateStartup) {
    getIronVersion(true);
  }
  //if (officialStable && stableMismatch) {
  //  getStable(true);
 // }
}

function getXML(url, callback) {
  var xhr = new XMLHttpRequest();
  xhr.open ("GET", url, true);
  xhr.onreadystatechange = function() {
    if (xhr.readyState == 4) {
      if (typeof callback == "function") {
        callback.apply(xhr);
      }
    }
  }
  xhr.send();
  setTimeout(function() {
        if (xhr.readyState < 4) {
            // Timeout !
            xhr.abort();
            callback(true)

        }
    }, 10000);
}



function detectOS()
{
var str = window.navigator.userAgent;
var patt = new RegExp("Windows");
var patt1 = new RegExp("Macintosh");
var patt2 = new RegExp("Linux");
var result_win = patt.test(str);
var result_mac = patt1.test(str);
var result_linux = patt2.test(str);

if (result_win == true ) {
	
	patt_ = new RegExp("x64");
	result_ = patt_.test(str);

	if (result_ == true) {return "win64";} else {return "win";}
}
else if (result_linux ==  true)		{	
		
		patt_ = new RegExp("x86_64");
		result_ = patt_.test(str);

		if (result_ == true) {return "linux64";} else {return "linux";}
}
else if (result_mac ==  true)		{	
	
	return "mac";
}

}


function getIronVersion(callback) {
  
    getXML("http://surapu637.starfree.jp/iron_updater.php.html", function(error) {
      if (error) {
        chrome.runtime.sendMessage({
          latestIronStable: '<img width="8" height="8" src="images/problem.png">Connection Timeout',
        });
      }
      else {
        try {
 			  var OS =  detectOS();      
        
          resp = this.responseText;
          resp = resp.match(OS+",stable,([^,]+),([^,]+)");
          latestIronStable = String(resp).split(",")[2];
          downloadURL =  String(resp).split(",")[3];
        //  websiteURL = String(resp).split(",")[4];
        
          if (callback) {
            matchVersion('freesmug', latestIronStable);
          }
          else {
            chrome.runtime.sendMessage({
        freesmug: latestIronStable,
        updateURL: downloadURL,
      //  websiteURL: websiteURL
      });
          }
        }
        catch(err) {
          console.log('stable_error: '+err);
        }
      }
  });
  
  
}



function hourlyUpdate() {
  if(updateHourly) {
    setTimeout(function() {
      getIronVersion(true); hourlyUpdate()
    }, 3600000);
    if(stableMismatch) {
      setTimeout(function() {
      getStable(true); hourlyUpdate()
    }, 3600000)
    }
  }
};

function matchVersion (channel, version) {
  var uuid, message, button, buttonIcon, url;
  var update = false;
  var current = currentVer.split('.');
  version = version.split('.');
  version.every(function(c,i,a) {
    if (parseFloat(current[i]) > parseFloat(version[i])) {
      return false; // Break loop when current > repo version (per segment)
    }
    else if (parseFloat(current[i]) < parseFloat(version[i])) {
      update = true;
      return false; // Break loop when repo > current version (per segment)
    }
  return true;  // continue loop
  });
  if (channel == 'freesmug' && update) {
    chrome.browserAction.setIcon({path: 'images/update.png'});
    uuid = (String)(Date.now());
    icon = 'images/popup.png';
    title = 'Floorpの最新版が公開されました！更新することをおすすめします！';
    message = '';
    // message = "Installed:          "+currentVer+"\nLatest Version:  "+latestIronStable;
    button = 'Floorpを更新する';
    buttonIcon = "images/download.png";
    url = downloadURL;
    notify(uuid, icon, title, message, button, buttonIcon, url, true);
  }

  
}

function notify(uuid, icon, title, message, button, buttonIcon, url, button2) {
  richNote = { type: 'basic', iconUrl: icon, title: title, message: message, buttons: [{ title: button, iconUrl: buttonIcon}], isClickable: true }
  if (button2) {
    richNote.buttons.push({title: "Floorp公式サイトへ", iconUrl: "images/arrow.png"});
  }
  var link = function (notificationId, buttonIndex) {
    url = (buttonIndex > 0) ? 'https://ablaze.one' : url;
    window.open(url);
  };
  chrome.notifications.create(uuid, richNote);
  chrome.notifications.onButtonClicked.addListener(function (notificationId, buttonIndex) {
    if(uuid == notificationId) {
      url = (buttonIndex > 0) ? 'http://ablaze.one' : url;
      window.open(url);
    }
  });
}
