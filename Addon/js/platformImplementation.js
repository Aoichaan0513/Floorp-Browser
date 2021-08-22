var xBrowserSync = xBrowserSync || {};
xBrowserSync.App = xBrowserSync.App || {};

/* ------------------------------------------------------------------------------------
 * Class name:  xBrowserSync.App.PlatformImplementation 
 * Description: Implements xBrowserSync.App.Platform for Chrome extension.
 * ------------------------------------------------------------------------------------ */

xBrowserSync.App.PlatformImplementation = function ($interval, $q, $timeout, platform, globals, utility, bookmarks) {
  'use strict';

  var vm, loadingId, refreshInterfaceTimeout,
    contentScriptUrl = 'js/getPageMetadata.js',
    optionalPermissions = {
      origins: ['http://*/', 'https://*/']
    },
    unsupportedContainers = [
      globals.Bookmarks.MenuContainerName,
      globals.Bookmarks.MobileContainerName
    ];


	/* ------------------------------------------------------------------------------------
	 * Constructor
	 * ------------------------------------------------------------------------------------ */

  var ChromeImplementation = function () {
    // Inject required platform implementation functions
    platform.AutomaticUpdates.NextUpdate = getAutoUpdatesNextRun;
    platform.AutomaticUpdates.Start = startAutoUpdates;
    platform.AutomaticUpdates.Stop = stopAutoUpdates;
    platform.Bookmarks.Clear = clearBookmarks;
    platform.Bookmarks.Created = bookmarksCreated;
    platform.Bookmarks.CreateSingle = createSingle;
    platform.Bookmarks.Deleted = bookmarksDeleted;
    platform.Bookmarks.DeleteSingle = deleteSingle;
    platform.Bookmarks.Get = getBookmarks;
    platform.Bookmarks.GetLocalBookmarkLocationInfo = getLocalBookmarkLocationInfo;
    platform.Bookmarks.LocalBookmarkInToolbar = localBookmarkInToolbar;
    platform.Bookmarks.Moved = bookmarksMoved;
    platform.Bookmarks.Populate = populateBookmarks;
    platform.Bookmarks.ShouldSyncLocalChanges = shouldSyncLocalChanges;
    platform.Bookmarks.Updated = bookmarksUpdated;
    platform.Bookmarks.UpdateSingle = updateSingle;
    platform.CopyToClipboard = copyToClipboard;
    platform.DownloadFile = downloadFile;
    platform.EventListeners.Enable = enableEventListeners;
    platform.EventListeners.Disable = disableEventListeners;
    platform.GetConstant = getConstant;
    platform.GetCurrentUrl = getCurrentUrl;
    platform.GetHelpPages = getHelpPages;
    platform.GetNewTabUrl = getNewTabUrl;
    platform.GetPageMetadata = getPageMetadata;
    platform.GetSupportedUrl = getSupportedUrl;
    platform.Init = init;
    platform.Interface.Working.Hide = hideLoading;
    platform.Interface.Working.Show = displayLoading;
    platform.Interface.Refresh = refreshInterface;
    platform.LocalStorage.Get = getFromLocalStorage;
    platform.LocalStorage.Set = setInLocalStorage;
    platform.OpenUrl = openUrl;
    platform.Permissions.Check = checkPermissions;
    platform.Permissions.Remove = removePermissions;
    platform.Permissions.Request = requestPermissions;
    platform.Sync.Current = getCurrentSync;
    platform.Sync.Disable = disableSync;
    platform.Sync.GetQueueLength = getSyncQueueLength;
    platform.Sync.Queue = queueSync;
  };


	/* ------------------------------------------------------------------------------------
	 * Public functions
	 * ------------------------------------------------------------------------------------ */

  var bookmarksCreated = function (xBookmarks, changeInfo) {
    // Remove native bookmark id
    delete changeInfo.bookmark.id;

    // Create synced bookmark
    return bookmarks.AddNewInXBookmarks(changeInfo.bookmark, changeInfo.container, changeInfo.indexPath, xBookmarks);
  };

  var bookmarksDeleted = function (xBookmarks, changeInfo) {
    // Remove synced bookmark
    return bookmarks.RemoveExistingInXBookmarks(changeInfo.container, changeInfo.indexPath, xBookmarks);
  };

  var bookmarksMoved = function (xBookmarks, changeInfo) {
    // Check if no need to sync either change
    if (!changeInfo.syncChange && !changeInfo.targetInfo.syncChange) {
      return $q.resolve({ bookmarks: null });
    }

    // Remove synced bookmark if syncing move from
    return (changeInfo.syncChange ?
      bookmarks.RemoveExistingInXBookmarks(changeInfo.container, changeInfo.indexPath, xBookmarks) :
      $q(function (resolve) {
        // If not syncing move from, create a new bookmark from local bookmark to avoid unsynced conflicts
        var convertedBookmark = bookmarks.ConvertLocalBookmarkToXBookmark(changeInfo.bookmark, xBookmarks);
        resolve({
          bookmark: convertedBookmark,
          bookmarks: xBookmarks
        });
      })
    )
      .then(function (results) {
        // Ensure a new bookmark id is created if not syncing the initial remove
        if (!changeInfo.syncChange && changeInfo.targetInfo.syncChange) {
          delete results.bookmark.id;
        }

        // Create synced bookmark if syncing move to
        return (changeInfo.targetInfo.syncChange ?
          bookmarks.AddNewInXBookmarks(results.bookmark, changeInfo.targetInfo.container, changeInfo.targetInfo.indexPath, results.bookmarks) :
          $q.resolve(results));
      });
  };

  var bookmarksUpdated = function (xBookmarks, changeInfo) {
    // Update synced bookmark
    return bookmarks.UpdateExistingInXBookmarks(changeInfo.bookmark, changeInfo.container, changeInfo.indexPath, xBookmarks);
  };

  var clearBookmarks = function () {
    // Get local container node ids
    return getLocalContainerIds()
      .then(function (localContainerIds) {
        var otherBookmarksId = localContainerIds[globals.Bookmarks.OtherContainerName];
        var toolbarBookmarksId = localContainerIds[globals.Bookmarks.ToolbarContainerName];

        // Clear other bookmarks
        var clearOthers = $q(function (resolve, reject) {
          chrome.bookmarks.getChildren(otherBookmarksId, function (results) {
            var apiError = checkForApiError();
            if (apiError) {
              return reject(apiError);
            }

            $q.all(results.map(function (child) {
              return deleteLocalBookmarksTree(child.id);
            }))
              .then(resolve)
              .catch(reject);
          });
        })
          .catch(function (err) {
            utility.LogWarning('Error clearing other bookmarks');
            throw err;
          });

        // Clear bookmarks toolbar if enabled
        var clearToolbar = bookmarks.GetSyncBookmarksToolbar()
          .then(function (syncBookmarksToolbar) {
            if (!syncBookmarksToolbar) {
              utility.LogInfo('Not clearing toolbar');
              return;
            }

            return $q(function (resolve, reject) {
              chrome.bookmarks.getChildren(toolbarBookmarksId, function (results) {
                var apiError = checkForApiError();
                if (apiError) {
                  return reject(apiError);
                }

                $q.all(results.map(function (child) {
                  return deleteLocalBookmarksTree(child.id);
                }))
                  .then(resolve)
                  .catch(reject);
              });
            });
          })
          .catch(function (err) {
            utility.LogWarning('Error clearing bookmarks toolbar');
            throw err;
          });

        return $q.all([clearOthers, clearToolbar]);
      })
      .catch(function (err) {
        return $q.reject({
          code: globals.ErrorCodes.FailedRemoveLocalBookmarks,
          stack: err.stack
        });
      });
  };

  var checkPermissions = function () {
    return $q(function (resolve, reject) {
      // Check if extension has optional permissions
      chrome.permissions.contains(optionalPermissions, function (hasPermissions) {
        var apiError = checkForApiError();
        if (apiError) {
          return reject(apiError);
        }

        resolve(hasPermissions);
      });
    });
  };

  var copyToClipboard = function (textToCopy) {
    return navigator.clipboard.writeText(textToCopy)
      .catch(function (err) {
        utility.LogError(err, 'platform.copyToClipboard');
        throw err;
      });
  };

  var createSingle = function (bookmarkToCreate, pathToTarget) {
    // Get parent local bookmark id from path and create local bookmark
    return findLocalBookmarkByPath(pathToTarget.slice(1, pathToTarget.length - 1))
      .then(function (parentLocalBookmark) {
        return createLocalBookmark(parentLocalBookmark.id, bookmarkToCreate.title, bookmarkToCreate.url);
      });
  };

  var deleteSingle = function (pathToTarget) {
    // Get local bookmark id from path and then delete
    return findLocalBookmarkByPath(pathToTarget.slice(1))
      .then(function (bookmarkToDelete) {
        if (!bookmarkToDelete) {
          return $q.reject({ code: globals.ErrorCodes.LocalBookmarkNotFound });
        }

        return deleteLocalBookmarksTree(bookmarkToDelete.id);
      });
  };

  var disableEventListeners = function () {
    return sendMessage({
      command: globals.Commands.DisableEventListeners
    });
  };

  var disableSync = function () {
    return sendMessage({
      command: globals.Commands.DisableSync
    });
  };

  var displayLoading = function (id) {
    var timeout;

    // Return if loading overlay already displayed
    if (loadingId) {
      return;
    }

    // Hide any alert messages
    vm.alert.show = false;

    switch (id) {
      // Checking updated service url, wait a moment before displaying loading overlay
      case 'checkingNewServiceUrl':
        timeout = $timeout(function () {
          vm.working.show = true;
        }, 100);
        break;
      // Loading bookmark metadata, wait a moment before displaying loading overlay
      case 'retrievingMetadata':
        timeout = $timeout(function () {
          vm.working.show = true;
        }, 500);
        break;
      // Display default overlay
      default:
        timeout = $timeout(function () {
          vm.working.show = true;
        });
        break;
    }

    loadingId = id;
    return timeout;
  };

  var downloadFile = function (fileName, textContents, linkId) {
    if (!fileName) {
      throw new Error('File name not supplied.');
    }

    // Use provided hyperlink or create new one
    var downloadLink;
    if (linkId) {
      downloadLink = document.getElementById(linkId);
    }
    else {
      downloadLink = document.createElement('a');
      downloadLink.style.display = 'none';
      document.body.appendChild(downloadLink);
    }

    if (!downloadLink) {
      throw new Error('Link element not found.');
    }

    utility.LogInfo('Downloading file ' + fileName);

    // Use hyperlink to trigger file download
    var file = new Blob([textContents], { type: 'text/plain' });
    downloadLink.href = URL.createObjectURL(file);
    downloadLink.innerText = fileName;
    downloadLink.download = fileName;
    downloadLink.click();

    if (!linkId) {
      document.body.removeChild(downloadLink);
    }

    // Return message to be displayed
    var message = getConstant(globals.Constants.DownloadFile_Success_Message);
    return $q.resolve(message);
  };

  var enableEventListeners = function () {
    return sendMessage({
      command: globals.Commands.EnableEventListeners
    });
  };

  var getAutoUpdatesNextRun = function () {
    return $q(function (resolve, reject) {
      chrome.alarms.get(globals.Alarm.Name, function (alarm) {
        if (!alarm) {
          return resolve();
        }

        resolve(utility.Get24hrTimeFromDate(new Date(alarm.scheduledTime)));
      });
    });
  };

  var getBookmarks = function (addBookmarkIds) {
    addBookmarkIds = addBookmarkIds || true;
    var allLocalBookmarks = [];

    // Get local container node ids
    return getLocalContainerIds()
      .then(function (localContainerIds) {
        var menuBookmarksId = localContainerIds[globals.Bookmarks.MenuContainerName];
        var mobileBookmarksId = localContainerIds[globals.Bookmarks.MobileContainerName];
        var otherBookmarksId = localContainerIds[globals.Bookmarks.OtherContainerName];
        var toolbarBookmarksId = localContainerIds[globals.Bookmarks.ToolbarContainerName];

        // Get other bookmarks
        var getOtherBookmarks = otherBookmarksId == null ? $q.resolve() :
          getLocalBookmarkTree(otherBookmarksId)
            .then(function (otherBookmarks) {
              if (!otherBookmarks.children || otherBookmarks.children.length === 0) {
                return;
              }

              // Add all bookmarks into flat array
              bookmarks.Each(otherBookmarks.children, function (bookmark) {
                allLocalBookmarks.push(bookmark);
              });

              // Convert local bookmarks sub tree to xbookmarks
              var xBookmarks = getLocalBookmarksAsXBookmarks(otherBookmarks.children);

              // Remove any unsupported container folders present
              var xBookmarksWithoutContainers = xBookmarks.filter(function (x) {
                return !unsupportedContainers.find(function (y) {
                  return y === x.title;
                });
              });

              return xBookmarksWithoutContainers;
            });

        // Get toolbar bookmarks if enabled
        var getToolbarBookmarks = toolbarBookmarksId == null ? $q.resolve() :
          $q.all([
            bookmarks.GetSyncBookmarksToolbar(),
            getLocalBookmarkTree(toolbarBookmarksId)
          ])
            .then(function (results) {
              var syncBookmarksToolbar = results[0];
              var toolbarBookmarks = results[1];

              if (!syncBookmarksToolbar) {
                return;
              }

              if (toolbarBookmarks.children && toolbarBookmarks.children.length > 0) {
                // Add all bookmarks into flat array
                bookmarks.Each(toolbarBookmarks.children, function (bookmark) {
                  allLocalBookmarks.push(bookmark);
                });

                return getLocalBookmarksAsXBookmarks(toolbarBookmarks.children);
              }
            });

        // Get menu bookmarks
        var getMenuBookmarks = menuBookmarksId == null ? $q.resolve() :
          getLocalBookmarkTree(menuBookmarksId)
            .then(function (menuBookmarks) {
              if (menuBookmarks.children && menuBookmarks.children.length > 0) {
                return getLocalBookmarksAsXBookmarks(menuBookmarks.children);
              }
            });

        // Get mobile bookmarks
        var getMobileBookmarks = mobileBookmarksId == null ? $q.resolve() :
          getLocalBookmarkTree(mobileBookmarksId)
            .then(function (mobileBookmarks) {
              if (mobileBookmarks.children && mobileBookmarks.children.length > 0) {
                return getLocalBookmarksAsXBookmarks(mobileBookmarks.children);
              }
            });

        return $q.all([getOtherBookmarks, getToolbarBookmarks, getMenuBookmarks, getMobileBookmarks]);
      })
      .then(function (results) {
        var otherBookmarks = results[0];
        var toolbarBookmarks = results[1];
        var menuBookmarks = results[2];
        var mobileBookmarks = results[3];
        var xBookmarks = [];
        var otherContainer, toolbarContainer, menuContainer, mobileContainer;

        // Add other container if bookmarks present
        if (otherBookmarks && otherBookmarks.length > 0) {
          otherContainer = bookmarks.GetContainer(globals.Bookmarks.OtherContainerName, xBookmarks, true);
          otherContainer.children = otherBookmarks;
        }

        // Add toolbar container if bookmarks present
        if (toolbarBookmarks && toolbarBookmarks.length > 0) {
          toolbarContainer = bookmarks.GetContainer(globals.Bookmarks.ToolbarContainerName, xBookmarks, true);
          toolbarContainer.children = toolbarBookmarks;
        }

        // Add menu container if bookmarks present
        if (menuBookmarks && menuBookmarks.length > 0) {
          menuContainer = bookmarks.GetContainer(globals.Bookmarks.MenuContainerName, xBookmarks, true);
          menuContainer.children = menuBookmarks;
        }

        // Add mobile container if bookmarks present
        if (mobileBookmarks && mobileBookmarks.length > 0) {
          mobileContainer = bookmarks.GetContainer(globals.Bookmarks.MobileContainerName, xBookmarks, true);
          mobileContainer.children = mobileBookmarks;
        }

        // Filter containers from flat array of bookmarks
        [otherContainer, toolbarContainer, menuContainer, mobileContainer].forEach(function (container) {
          if (!container) {
            return;
          }

          allLocalBookmarks = allLocalBookmarks.filter(function (bookmark) {
            return bookmark.title !== container.title;
          });
        });

        // Sort by date added asc 
        allLocalBookmarks = allLocalBookmarks.sort(function (x, y) {
          return x.dateAdded - y.dateAdded;
        });

        // Iterate local bookmarks to add unique bookmark ids in correct order 
        allLocalBookmarks.forEach(function (localBookmark) {
          bookmarks.Each(xBookmarks, function (xBookmark) {
            if (!xBookmark.id && (
              (!localBookmark.url && xBookmark.title === localBookmark.title) ||
              (localBookmark.url && xBookmark.url === localBookmark.url))) {
              xBookmark.id = bookmarks.GetNewBookmarkId(xBookmarks);
            }
          });
        });

        // Find and fix any bookmarks missing ids
        bookmarks.Each(xBookmarks, function (xBookmark) {
          if (!xBookmark.id) {
            xBookmark.id = bookmarks.GetNewBookmarkId(xBookmarks);
          }
        });

        return xBookmarks;
      });
  };

  var getConstant = function (constName) {
    return chrome.i18n.getMessage(constName);
  };

  var getCurrentSync = function () {
    return sendMessage({
      command: globals.Commands.GetCurrentSync
    })
      .then(function (response) {
        return response.currentSync;
      });
  };

  var getCurrentUrl = function () {
    return $q(function (resolve, reject) {
      // Get current tab
      chrome.tabs.query(
        { currentWindow: true, active: true },
        function (tabs) {
          var apiError = checkForApiError();
          if (apiError) {
            return reject(apiError);
          }

          resolve(tabs[0].url);
        });
    });
  };

  var getHelpPages = function () {
    var pages = [
      platform.GetConstant(globals.Constants.Help_Page_Welcome_Desktop_Content),
      platform.GetConstant(globals.Constants.Help_Page_BeforeYouBegin_Chrome_Content),
      platform.GetConstant(globals.Constants.Help_Page_FirstSync_Desktop_Content),
      platform.GetConstant(globals.Constants.Help_Page_Service_Content),
      platform.GetConstant(globals.Constants.Help_Page_SyncId_Content),
      platform.GetConstant(globals.Constants.Help_Page_ExistingId_Desktop_Content),
      platform.GetConstant(globals.Constants.Help_Page_Searching_Desktop_Content),
      platform.GetConstant(globals.Constants.Help_Page_AddingBookmarks_Chrome_Content),
      platform.GetConstant(globals.Constants.Help_Page_NativeFeatures_Chrome_Content),
      platform.GetConstant(globals.Constants.Help_Page_BackingUp_Desktop_Content),
      platform.GetConstant(globals.Constants.Help_Page_Shortcuts_Chrome_Content),
      platform.GetConstant(globals.Constants.Help_Page_Mobile_Content),
      platform.GetConstant(globals.Constants.Help_Page_FurtherSupport_Content)
    ];

    return pages;
  };

  var getFromLocalStorage = function (storageKeys) {
    return $q(function (resolve, reject) {
      chrome.storage.local.get(storageKeys, function (storageItems) {
        var apiError = checkForApiError();
        if (apiError) {
          return reject(apiError);
        }

        if (storageKeys == null || Array.isArray(storageKeys)) {
          resolve(storageItems);
        }
        else {
          resolve(storageItems[storageKeys]);
        }
      });
    });
  };

  var getLocalBookmarkLocationInfo = function (localBookmarkId, initialIndexPath) {
    var indexPath = initialIndexPath || [];
    var localBookmarkTree, containerId, containerName;

    // Create the condition check for the promise loop
    var doActionUntil = function (id) {
      // Check if the current bookmark is a container
      return isLocalBookmarkContainer(id)
        .then(function (localContainer) {
          if (localContainer) {
            // Retain the container info
            containerId = id;
            containerName = localContainer.xBookmarkTitle;
          }
          return !!localContainer;
        });
    };

    // Create the action for the promise loop
    var action = function (id) {
      return $q(function (resolve, reject) {
        // Find the current local bookmark in the tree, add it's index to the path then process it's parent
        var localBookmark = bookmarks.FindBookmarkById(localBookmarkTree.children, id);
        if (!localBookmark) {
          return reject({ code: globals.ErrorCodes.LocalBookmarkNotFound });
        }
        indexPath.unshift(localBookmark.index);

        // Next process the parent
        resolve(localBookmark.parentId);
      });
    };

    return getLocalBookmarkTree()
      .then(function (tree) {
        // Return if local bookmark is not found in tree
        var localBookmark = bookmarks.FindBookmarkById(tree.children, localBookmarkId);
        if (!localBookmark) {
          return $q.reject({ code: globals.ErrorCodes.LocalBookmarkNotFound });
        }

        // Create the index path to the bookmark
        localBookmarkTree = tree;
        return utility.PromiseWhile(localBookmarkId, doActionUntil, action)
          .then(function () {
            // Adjust child index of other bookmarks to account for any unsupported containers
            return getNumContainersBeforeBookmarkIndex(containerId, indexPath[0])
              .then(function (numContainers) {
                // Adjust the initial index by the number of containers
                return [indexPath[0] - numContainers].concat(indexPath.slice(1));
              });
          })
          .then(function (adjustedIndexPath) {
            return {
              container: containerName,
              indexPath: adjustedIndexPath
            };
          });
      });
  };

  var getNewTabUrl = function () {
    return 'chrome://newtab/';
  };

  var getPageMetadata = function (getFullMetadata, pageUrl) {
    var activeTab;
    getFullMetadata = getFullMetadata === undefined ? true : getFullMetadata;

    return $q(function (resolve, reject) {
      chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
        var apiError = checkForApiError();
        if (apiError) {
          return reject(apiError);
        }

        resolve(tabs);
      });
    })
      .then(function (tabs) {
        // If active tab empty, throw error
        activeTab = tabs && tabs[0];
        if (!activeTab) {
          return $q.reject({ code: globals.ErrorCodes.FailedGetPageMetadata });
        }

        // Default metadata to the info from the active tab
        var metadata = activeTab && {
          title: activeTab.title,
          url: activeTab.url
        };

        // Don't get metadata if this is a chrome url
        if (getFullMetadata) {
          getFullMetadata = !(/chrome\:\/\//i).test(activeTab.url);
        }

        return $q(function (resolve) {
          // Return if not getting metadata
          if (!getFullMetadata) {
            return resolve(metadata);
          }

          chrome.tabs.executeScript(activeTab.id, { file: contentScriptUrl }, function (response) {
            var apiError = checkForApiError();
            if (apiError) {
              utility.LogWarning('Unable to get metadata.');
              return resolve(metadata);
            }

            if (!response) {
              return resolve(metadata);
            }

            // If no metadata returned, use the info from the active tab
            metadata = response[0];
            metadata.title = metadata.title || activeTab.title;
            metadata.url = metadata.url || activeTab.url;
            resolve(metadata);
          });
        });
      });
  };

  var getSyncQueueLength = function () {
    return sendMessage({
      command: globals.Commands.GetSyncQueueLength
    })
      .then(function (response) {
        return response.syncQueueLength;
      });
  };

  var getSupportedUrl = function (url) {
    return localBookmarkUrlIsSupported(url) ? url : getNewTabUrl();
  };

  var hideLoading = function (id, timeout) {
    if (timeout) {
      $timeout.cancel(timeout);
    }

    // Hide any alert messages
    vm.alert.show = false;

    // Hide loading overlay if supplied if matches current
    if (!loadingId || id === loadingId) {
      vm.working.show = false;
      loadingId = null;
    }
  };

  var init = function (viewModel) {
    // Set global variables
    vm = viewModel;
    vm.platformName = globals.Platforms.Chrome;

    return $q.resolve();
  };

  var localBookmarkInToolbar = function (localBookmark) {
    return getLocalContainerIds()
      .then(function (localContainerIds) {
        return localBookmark.parentId === localContainerIds[globals.Bookmarks.ToolbarContainerName];
      });
  };

  var openUrl = function (url) {
    // Check url is supported
    if (!localBookmarkUrlIsSupported(url)) {
      utility.LogInfo('Attempted to navigate to unsupported url: ' + url);
      url = getNewTabUrl();
    }

    var openInNewTab = function () {
      chrome.tabs.create({ 'url': url });
    };

    chrome.tabs.query({ currentWindow: true, active: true }, function (tabs) {
      var apiError = checkForApiError();
      if (apiError) {
        return reject(apiError);
      }

      // Open url in current tab if new
      if (tabs && tabs.length > 0 && tabs[0].url && tabs[0].url.startsWith(getNewTabUrl())) {
        chrome.tabs.update(tabs[0].id, { url: url }, function () {
          window.close();
        });
      }
      else {
        openInNewTab();
      }
    });
  };

  var populateBookmarks = function (xBookmarks) {
    var populateStartTime = new Date();

    // Get containers
    var menuContainer = bookmarks.GetContainer(globals.Bookmarks.MenuContainerName, xBookmarks);
    var mobileContainer = bookmarks.GetContainer(globals.Bookmarks.MobileContainerName, xBookmarks);
    var otherContainer = bookmarks.GetContainer(globals.Bookmarks.OtherContainerName, xBookmarks);
    var toolbarContainer = bookmarks.GetContainer(globals.Bookmarks.ToolbarContainerName, xBookmarks);

    // Get local container node ids
    return getLocalContainerIds()
      .then(function (localContainerIds) {
        var otherBookmarksId = localContainerIds[globals.Bookmarks.OtherContainerName];
        var toolbarBookmarksId = localContainerIds[globals.Bookmarks.ToolbarContainerName];

        // Populate menu bookmarks in other bookmarks
        var populateMenu = $q(function (resolve, reject) {
          if (menuContainer) {
            chrome.bookmarks.getSubTree(otherBookmarksId, function (results) {
              var apiError = checkForApiError();
              if (apiError) {
                utility.LogWarning('Error populating bookmarks menu.');
                return reject(apiError);
              }

              createLocalBookmarksFromXBookmarks(otherBookmarksId, [menuContainer], toolbarBookmarksId)
                .then(resolve)
                .catch(reject);
            });
          }
          else {
            resolve();
          }
        });

        // Populate mobile bookmarks in other bookmarks
        var populateMobile = $q(function (resolve, reject) {
          if (mobileContainer) {
            chrome.bookmarks.getSubTree(otherBookmarksId, function (results) {
              var apiError = checkForApiError();
              if (apiError) {
                utility.LogWarning('Error populating mobile bookmarks.');
                return reject(apiError);
              }

              createLocalBookmarksFromXBookmarks(otherBookmarksId, [mobileContainer], toolbarBookmarksId)
                .then(resolve)
                .catch(reject);
            });
          }
          else {
            resolve();
          }
        });

        // Populate other bookmarks
        var populateOther = $q(function (resolve, reject) {
          if (otherContainer) {
            chrome.bookmarks.getSubTree(otherBookmarksId, function (results) {
              var apiError = checkForApiError();
              if (apiError) {
                utility.LogWarning('Error populating other bookmarks.');
                return reject(apiError);
              }

              createLocalBookmarksFromXBookmarks(otherBookmarksId, otherContainer.children, toolbarBookmarksId)
                .then(resolve)
                .catch(reject);
            });
          }
          else {
            resolve();
          }
        });

        // Populate bookmarks toolbar if enabled
        var populateToolbar = bookmarks.GetSyncBookmarksToolbar()
          .then(function (syncBookmarksToolbar) {
            if (!syncBookmarksToolbar) {
              utility.LogInfo('Not populating toolbar');
              return;
            }

            if (toolbarContainer) {
              return $q(function (resolve, reject) {
                chrome.bookmarks.getSubTree(toolbarBookmarksId, function (results) {
                  var apiError = checkForApiError();
                  if (apiError) {
                    utility.LogWarning('Error populating bookmarks toolbar.');
                    return reject(apiError);
                  }

                  createLocalBookmarksFromXBookmarks(toolbarBookmarksId, toolbarContainer.children, toolbarBookmarksId)
                    .then(resolve)
                    .catch(reject);
                });
              });
            }
          });

        return $q.all([populateMenu, populateMobile, populateOther, populateToolbar]);
      })
      .then(function () {
        var populateEndTime = new Date();
        utility.LogInfo('Local population completed in ' + ((populateEndTime - populateStartTime) / 1000) + 's');
        return reorderLocalContainers();
      });
  };

  var queueSync = function (syncData, command) {
    syncData.command = command || globals.Commands.SyncBookmarks;
    return sendMessage(syncData)
      .then(function (response) {
        return response.bookmarks;
      });
  };

  var refreshInterface = function (syncEnabled, syncType) {
    var iconPath, newTitle = getConstant(globals.Constants.Title);
    var syncingTitle = ' (' + getConstant(globals.Constants.Tooltip_Syncing_Label) + ')';
    var syncedTitle = ' (' + getConstant(globals.Constants.Tooltip_Synced_Label) + ')';
    var notSyncedTitle = ' (' + getConstant(globals.Constants.Tooltip_NotSynced_Label) + ')';

    // Clear timeout
    if (refreshInterfaceTimeout) {
      $timeout.cancel(refreshInterfaceTimeout);
      refreshInterfaceTimeout = null;
    }

    if (syncType) {
      iconPath = syncType === globals.SyncType.Pull ? 'img/downloading.png' : 'img/uploading.png';
      newTitle += syncingTitle;
    }
    else if (syncEnabled) {
      iconPath = 'img/synced.png';
      newTitle += syncedTitle;
    }
    else {
      iconPath = 'img/notsynced.png';
      newTitle += notSyncedTitle;
    }

    return $q(function (resolve, reject) {
      var iconUpdated = $q.defer();
      var titleUpdated = $q.defer();

      chrome.browserAction.getTitle({}, function (currentTitle) {
        // Don't do anything if browser action title hasn't changed 
        if (newTitle === currentTitle) {
          return resolve();
        }

        // Set a delay if finished syncing to prevent flickering when executing many syncs
        if (currentTitle.indexOf(syncingTitle) > 0 && newTitle.indexOf(syncedTitle)) {
          refreshInterfaceTimeout = $timeout(function () {
            chrome.browserAction.setIcon({ path: iconPath });
            chrome.browserAction.setTitle({ title: newTitle });
          }, 350);
          iconUpdated.resolve();
          titleUpdated.resolve();
        }
        else {
          chrome.browserAction.setIcon({ path: iconPath }, iconUpdated.resolve);
          chrome.browserAction.setTitle({ title: newTitle }, titleUpdated.resolve);
        }

        $q.all([iconUpdated, titleUpdated])
          .then(resolve)
          .catch(reject);
      });
    });
  };

  var removePermissions = function () {
    return $q(function (resolve, reject) {
      // Remove optional permissions
      chrome.permissions.remove(optionalPermissions, function (removed) {
        var apiError = checkForApiError();
        if (apiError) {
          return reject(apiError);
        }

        if (!removed) {
          return reject(new Error('Permissions not removed'));
        }

        utility.LogInfo('Optional permissions removed');
        resolve();
      });
    });
  };

  var requestPermissions = function () {
    return $q(function (resolve, reject) {
      // Request optional permissions
      chrome.permissions.request(optionalPermissions, function (granted) {
        var apiError = checkForApiError();
        if (apiError) {
          return reject(apiError);
        }

        utility.LogInfo('Optional permissions ' + (!granted ? 'not ' : '') + 'granted');
        resolve(granted);
      });
    });
  };

  var setInLocalStorage = function (storageKey, value) {
    return $q(function (resolve, reject) {
      try {
        if (value != null) {
          var storageObj = {};
          storageObj[storageKey] = value;

          chrome.storage.local.set(storageObj, function () {
            resolve();
          });
        }
        else {
          chrome.storage.local.remove(storageKey, function () {
            var apiError = checkForApiError();
            if (apiError) {
              return reject(apiError);
            }

            resolve();
          });
        }
      }
      catch (err) {
        reject(err);
      }
    });
  };

  var shouldSyncLocalChanges = function (changeInfo, xBookmarks) {
    // If changed bookmark is a container, disable sync
    return wasContainerChanged(changeInfo.bookmark, xBookmarks)
      .then(function (changedBookmarkIsContainer) {
        if (changedBookmarkIsContainer) {
          return $q.reject({ code: globals.ErrorCodes.ContainerChanged });
        }

        // If container is Toolbar, check if Toolbar sync is disabled
        return changeInfo.container === globals.Bookmarks.ToolbarContainerName ? bookmarks.GetSyncBookmarksToolbar() : $q.resolve(true);
      })
      .then(function (syncBookmarksToolbar) {
        if (!syncBookmarksToolbar) {
          utility.LogInfo('Not syncing toolbar');
          return false;
        }

        return true;
      });
  };

  var startAutoUpdates = function () {
    return $q(function (resolve, reject) {
      // Register alarm
      chrome.alarms.clear(globals.Alarm.Name, function () {
        var apiError = checkForApiError();
        if (apiError) {
          apiError.code = globals.ErrorCodes.FailedRegisterAutoUpdates;
          return reject(apiError);
        }

        chrome.alarms.create(
          globals.Alarm.Name, {
          periodInMinutes: globals.Alarm.Period
        }
        );

        resolve();
      });
    });
  };

  var stopAutoUpdates = function () {
    chrome.alarms.clear(globals.Alarm.Name);
  };

  var updateSingle = function (updatedBookmark, pathToTarget) {
    // Get local bookmark id from path and then update
    return findLocalBookmarkByPath(pathToTarget.slice(1))
      .then(function (localBookmarkToUpdate) {
        if (!localBookmarkToUpdate) {
          return $q.reject({ code: globals.ErrorCodes.LocalBookmarkNotFound });
        }

        return updateLocalBookmark(localBookmarkToUpdate.id, updatedBookmark.title, updatedBookmark.url);
      });
  };


  /* ------------------------------------------------------------------------------------
   * Private functions
   * ------------------------------------------------------------------------------------ */

  var checkForApiError = function () {
    var err;

    if (chrome.runtime.lastError) {
      err = new Error(chrome.runtime.lastError.message);
      utility.LogError(err);
    }

    return err;
  };

  var createLocalBookmark = function (parentId, title, url, index) {
    var newLocalBookmark = {
      index: index,
      parentId: parentId,
      title: title,
      url: url
    };

    // Check that the url is supported
    if (!localBookmarkUrlIsSupported(url)) {
      utility.LogInfo('Bookmark url unsupported: ' + url);
      newLocalBookmark.url = getNewTabUrl();
    }

    return $q(function (resolve, reject) {
      chrome.bookmarks.create(newLocalBookmark, function (createdBookmark) {
        var apiError = checkForApiError();
        if (apiError) {
          utility.LogWarning('Failed to create local bookmark: ' + JSON.stringify(newLocalBookmark));
          apiError.code = globals.ErrorCodes.FailedCreateLocalBookmarks;
          return reject(apiError);
        }

        resolve(createdBookmark);
      });
    });
  };

  var createLocalBookmarksFromXBookmarks = function (parentId, xBookmarks, localToolbarContainerId) {
    var processError;
    var createRecursive = function (parentId, xBookmarks, localToolbarContainerId) {
      var createChildBookmarksPromises = [];

      // Create bookmarks at the top level of the supplied array
      return xBookmarks.reduce(function (p, xBookmark) {
        return p.then(function () {
          // If an error occurred during the recursive process, prevent any more bookmarks being created
          if (processError) {
            return $q.resolve();
          }

          return bookmarks.IsSeparator(xBookmark) ?
            createLocalSeparator(parentId, localToolbarContainerId) : createLocalBookmark(parentId, xBookmark.title, xBookmark.url)
              .then(function (newLocalBookmark) {
                // If the bookmark has children, recurse
                if (xBookmark.children && xBookmark.children.length > 0) {
                  createChildBookmarksPromises.push(createRecursive(newLocalBookmark.id, xBookmark.children, localToolbarContainerId));
                }
              });
        });
      }, $q.resolve())
        .then(function () {
          return $q.all(createChildBookmarksPromises);
        })
        .catch(function (err) {
          processError = err;
          throw err;
        });
    };
    return createRecursive(parentId, xBookmarks, localToolbarContainerId);
  };

  var createLocalSeparator = function (parentId, localToolbarContainerId) {
    var newLocalSeparator = {
      parentId: parentId,
      title: parentId === localToolbarContainerId ? globals.Bookmarks.VerticalSeparatorTitle : globals.Bookmarks.HorizontalSeparatorTitle,
      url: getNewTabUrl()
    };

    return $q(function (resolve, reject) {
      chrome.bookmarks.create(newLocalSeparator, function (createdSeparator) {
        var apiError = checkForApiError();
        if (apiError) {
          utility.LogWarning('Failed to create local separator');
          apiError.code = globals.ErrorCodes.FailedCreateLocalBookmarks;
          return reject(apiError);
        }

        resolve(createdSeparator);
      });
    });
  };

  var deleteLocalBookmarksTree = function (localBookmarkId) {
    return $q(function (resolve, reject) {
      chrome.bookmarks.removeTree(localBookmarkId, function () {
        var apiError = checkForApiError();
        if (apiError) {
          utility.LogWarning('Failed to delete local bookmark: ' + localBookmarkId);
          apiError.code = globals.ErrorCodes.FailedRemoveLocalBookmarks;
          return reject(apiError);
        }

        resolve();
      });
    });
  };

  var findLocalBookmarkByPath = function (path) {
    var otherBookmarksId, toolbarBookmarksId;
    var container = path.shift().bookmark;
    if (!bookmarks.XBookmarkIsContainer(container)) {
      // First path item should always be a container
      return $q.reject({ code: globals.ErrorCodes.LocalBookmarkNotFound });
    }

    // Get local container node ids
    return getLocalContainerIds()
      .then(function (localContainerIds) {
        otherBookmarksId = localContainerIds[globals.Bookmarks.OtherContainerName];
        toolbarBookmarksId = localContainerIds[globals.Bookmarks.ToolbarContainerName];

        // Check if container is unsupported in this browser
        var getLocalContainerIdPromise;
        if (unsupportedContainers.find(function (x) { return x === container.title; })) {
          // Container is unsupported, find folder under other bookmarks
          getLocalContainerIdPromise = $q(function (resolve, reject) {
            chrome.bookmarks.getChildren(otherBookmarksId, function (children) {
              var localContainer = children.find(function (x) { return x.title === container.title; });
              if (localContainer) {
                // Container folder found, return id
                resolve(localContainer.id);
              }
              else {
                // Unable to find local container folder 
                reject({ code: globals.ErrorCodes.LocalBookmarkNotFound });
              }
            });
          });
        }
        else {
          // Container is supported, return relevant id
          switch (container.title) {
            case globals.Bookmarks.OtherContainerName:
              getLocalContainerIdPromise = $q.resolve(otherBookmarksId);
              break;
            case globals.Bookmarks.ToolbarContainerName:
              getLocalContainerIdPromise = $q.resolve(toolbarBookmarksId);
              break;
          }
        }

        return getLocalContainerIdPromise;
      })
      .then(getLocalBookmarkTree)
      .then(function (bookmarkTree) {
        if (path.length === 0) {
          return bookmarkTree;
        }

        return utility.AsyncReduce(bookmarkTree, path,
          function (treePosition, pathCurrent) {
            return $q(function (resolve, reject) {
              if (!treePosition) {
                return resolve();
              }

              // If the current position is other bookmarks, 
              // check for any existing container folders that would throw off the target index
              var getLocalBookmarkIndex;
              if (treePosition.id === otherBookmarksId) {
                getLocalBookmarkIndex = getNumContainersBeforeBookmarkIndex(treePosition.id, pathCurrent.index)
                  .then(function (numContainers) {
                    // Adjust the index by the number of container folders
                    return pathCurrent.index + numContainers;
                  });
              }
              else {
                getLocalBookmarkIndex = $q.resolve(pathCurrent.index);
              }

              return getLocalBookmarkIndex
                .then(function (localBookmarkIndex) {
                  // Return the child at the matching index
                  var targetChild = treePosition.children.find(function (x) {
                    return x.index === localBookmarkIndex;
                  });
                  return resolve(targetChild);
                })
                .catch(reject);
            });
          }
        );
      });
  };

  var findLocalBookmarkByTitle = function (title) {
    if (!title) {
      return $q.resolve();
    }

    return $q(function (resolve, reject) {
      chrome.bookmarks.search({ title: title }, function (results) {
        var apiError = checkForApiError();
        if (apiError) {
          return reject(apiError);
        }

        var localBookmark;
        if (results.length > 0) {
          localBookmark = results.shift();
        }

        resolve(localBookmark);
      });
    });
  };

  var getLocalBookmarkTree = function (localBookmarkId) {
    return $q(function (resolve, reject) {
      var callback = function (tree) {
        var apiError = checkForApiError();
        if (apiError) {
          return reject(apiError);
        }

        if (!tree || tree.length < 1) {
          return reject();
        }
        resolve(tree[0]);
      };

      if (localBookmarkId != null) {
        chrome.bookmarks.getSubTree(localBookmarkId, callback);
      }
      else {
        chrome.bookmarks.getTree(callback);
      }
    })
      .catch(function (err) {
        utility.LogInfo(
          localBookmarkId != null ? 'Failed to get local bookmark tree at id: ' + localBookmarkId :
            'Failed to get local bookmark tree');
        return $q.reject({
          code: globals.ErrorCodes.FailedGetLocalBookmarks,
          stack: err.stack
        });
      });
  };

  var getLocalBookmarksAsXBookmarks = function (localBookmarks) {
    var xBookmarks = [];

    for (var i = 0; i < localBookmarks.length; i++) {
      var currentLocalBookmark = localBookmarks[i];

      // Check if current local bookmark is a separator
      var newXBookmark = bookmarks.IsSeparator(currentLocalBookmark) ? new bookmarks.XSeparator() :
        new bookmarks.XBookmark(currentLocalBookmark.title, currentLocalBookmark.url);

      // If this is a folder and has children, process them
      if (currentLocalBookmark.children && currentLocalBookmark.children.length > 0) {
        newXBookmark.children = getLocalBookmarksAsXBookmarks(currentLocalBookmark.children);
      }

      xBookmarks.push(newXBookmark);
    }

    return xBookmarks;
  };

  var getLocalContainerIds = function () {
    return getLocalBookmarkTree()
      .then(function (tree) {
        // Get the root child nodes
        var otherBookmarksNode = tree.children.find(function (x) { return x.id === '2'; });
        var toolbarBookmarksNode = tree.children.find(function (x) { return x.id === '1'; });

        // Throw an error if a local container is not found
        if (!otherBookmarksNode || !toolbarBookmarksNode) {
          if (!otherBookmarksNode) { utility.LogWarning('Missing container: other bookmarks'); }
          if (!toolbarBookmarksNode) { utility.LogWarning('Missing container: toolbar bookmarks'); }
          return $q.reject({ code: globals.ErrorCodes.LocalContainerNotFound });
        }

        // Add containers to results
        var results = {};
        results[globals.Bookmarks.OtherContainerName] = otherBookmarksNode.id;
        results[globals.Bookmarks.ToolbarContainerName] = toolbarBookmarksNode.id;

        // Check for unsupported containers
        var menuBookmarksNode = otherBookmarksNode.children.find(function (x) { return x.title === globals.Bookmarks.MenuContainerName; });
        var mobileBookmarksNode = otherBookmarksNode.children.find(function (x) { return x.title === globals.Bookmarks.MobileContainerName; });
        results[globals.Bookmarks.MenuContainerName] = menuBookmarksNode ? menuBookmarksNode.id : undefined;
        results[globals.Bookmarks.MobileContainerName] = mobileBookmarksNode ? mobileBookmarksNode.id : undefined;

        return results;
      });
  };

  var getNumContainersBeforeBookmarkIndex = function (parentId, bookmarkIndex) {
    return getLocalBookmarkTree(parentId)
      .then(function (localBookmark) {
        var numContainers = _.filter(localBookmark.children, bookmarks.XBookmarkIsContainer).length;
        return numContainers;
      });
  };

  var isLocalBookmarkContainer = function (localBookmarkId) {
    // Get local container node ids
    return getLocalContainerIds()
      .then(function (localContainerIds) {
        var menuBookmarksId = localContainerIds[globals.Bookmarks.MenuContainerName];
        var mobileBookmarksId = localContainerIds[globals.Bookmarks.MobileContainerName];
        var otherBookmarksId = localContainerIds[globals.Bookmarks.OtherContainerName];
        var toolbarBookmarksId = localContainerIds[globals.Bookmarks.ToolbarContainerName];

        var localContainers = [
          { id: otherBookmarksId, xBookmarkTitle: globals.Bookmarks.OtherContainerName },
          { id: toolbarBookmarksId, xBookmarkTitle: globals.Bookmarks.ToolbarContainerName }
        ];

        if (menuBookmarksId) {
          localContainers.push({ id: menuBookmarksId, xBookmarkTitle: globals.Bookmarks.MenuContainerName });
        }

        if (mobileBookmarksId) {
          localContainers.push({ id: mobileBookmarksId, xBookmarkTitle: globals.Bookmarks.MobileContainerName });
        }

        // Check if the bookmark id resolves to a local container
        return _.findWhere(localContainers, { id: localBookmarkId });
      });
  };

  var localBookmarkUrlIsSupported = function (url) {
    if (!url) {
      return true;
    }

    var supportedRegex = /^[\w\-]+:/i;
    return supportedRegex.test(url);
  };

  var reorderLocalContainers = function () {
    // Get local containers
    return $q.all(unsupportedContainers.map(findLocalBookmarkByTitle))
      .then(function (results) {
        // Remove falsy results
        var localContainers = results.filter(function (x) { return x; });

        // Reorder each local container to top of parent
        return $q.all(localContainers.map(function (localContainer, index) {
          return $q(function (resolve, reject) {
            chrome.bookmarks.move(
              localContainer.id,
              {
                index: index,
                parentId: localContainer.parentId
              },
              function (results) {
                var apiError = checkForApiError();
                if (apiError) {
                  return reject(apiError);
                }

                resolve();
              }
            );
          });
        }));
      });
  };

  var sendMessage = function (message) {
    return $q(function (resolve, reject) {
      chrome.runtime.sendMessage(message, function (response) {
        // Check for runtime errors
        if (chrome.runtime.lastError) {
          // If no message connection detected, check if background function can be called directly
          if (chrome.runtime.lastError.message.toLowerCase().indexOf('could not establish connection') >= 0) {
            if (window.xBrowserSync.App.HandleMessage) {
              return window.xBrowserSync.App.HandleMessage(message, null, resolve);
            }

            utility.LogWarning('Message listener not available');
            return reject(err);
          }

          return reject(new Error(chrome.runtime.lastError.message));
        }

        if (!response) {
          return resolve();
        }

        if (!response.success) {
          return reject(response.error);
        }

        resolve(response);
      });
    });
  };

  var updateLocalBookmark = function (localBookmarkId, title, url) {
    var updateInfo = {
      title: title,
      url: url
    };

    // Check that the url is supported
    if (!localBookmarkUrlIsSupported(url)) {
      utility.LogInfo('Bookmark url unsupported: ' + url);
      updateInfo.url = getNewTabUrl();
    }

    return $q(function (resolve, reject) {
      chrome.bookmarks.update(localBookmarkId, updateInfo, function (updatedBookmark) {
        var apiError = checkForApiError();
        if (apiError) {
          utility.LogWarning('Failed to update local bookmark: ' + JSON.stringify(updateInfo));
          apiError.code = globals.ErrorCodes.FailedUpdateLocalBookmarks;
          return reject(apiError);
        }

        resolve(updatedBookmark);
      });
    });
  };

  var wasContainerChanged = function (changedBookmark, xBookmarks) {
    return xBookmarks ? $q.resolve(xBookmarks) : bookmarks.GetBookmarks()
      .then(function (results) {
        xBookmarks = results;

        // Check based on title
        if (bookmarks.XBookmarkIsContainer(changedBookmark)) {
          return true;
        }

        // Get local container node ids
        return getLocalContainerIds()
          .then(function (localContainerIds) {
            // If parent is other bookmarks, check other bookmarks children for containers
            var otherBookmarksId = localContainerIds[globals.Bookmarks.OtherContainerName];
            if (changedBookmark.parentId !== otherBookmarksId) {
              return false;
            }

            return $q(function (resolve, reject) {
              try {
                chrome.bookmarks.getChildren(otherBookmarksId, function (children) {
                  var apiError = checkForApiError();
                  if (apiError) {
                    throw apiError;
                  }

                  // Get all bookmarks in other bookmarks that are xBrowserSync containers
                  var localContainers = children.filter(function (x) {
                    return unsupportedContainers.find(function (y) { return y === x.title; });
                  });
                  var containersCount = 0;
                  var checksFailed = false;
                  var count;

                  // Check each container present only appears once
                  var menuContainer = bookmarks.GetContainer(globals.Bookmarks.MenuContainerName, xBookmarks, false);
                  if (menuContainer) {
                    containersCount++;
                    count = localContainers.filter(function (x) {
                      return x.title === globals.Bookmarks.MenuContainerName;
                    }).length;
                    checksFailed = count !== 1 ? true : checksFailed;
                  }

                  var mobileContainer = bookmarks.GetContainer(globals.Bookmarks.MobileContainerName, xBookmarks, false);
                  if (mobileContainer) {
                    containersCount++;
                    count = localContainers.filter(function (x) {
                      return x.title === globals.Bookmarks.MobileContainerName;
                    }).length;
                    checksFailed = count !== 1 ? true : checksFailed;
                  }

                  // Check number of containers match and return result
                  checksFailed = containersCount !== localContainers.length ? true : checksFailed;
                  resolve(checksFailed);
                });
              }
              catch (err) {
                utility.LogInfo('Failed to detect whether container changed: ' + JSON.stringify(changedBookmark));
                return reject({
                  code: globals.ErrorCodes.FailedGetLocalBookmarks,
                  stack: err.stack
                });
              }
            });
          });
      });
  };

  // Call constructor
  return new ChromeImplementation();
};