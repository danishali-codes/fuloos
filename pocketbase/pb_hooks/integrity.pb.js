/// <reference path="../pb_data/types.d.ts" />
routerAdd("POST", "/api/fuloos/goals/{id}/contributions", (e) => require(`${__hooks}/integrity_lib.js`).contribute(e), $apis.requireAuth("fuloos_users"));
routerAdd("DELETE", "/api/fuloos/goal-contributions/{id}", (e) => require(`${__hooks}/integrity_lib.js`).removeContribution(e), $apis.requireAuth("fuloos_users"));
routerAdd("POST", "/api/fuloos/captured-alerts/{id}/import", (e) => require(`${__hooks}/integrity_lib.js`).importAlert(e), $apis.requireAuth("fuloos_users"));
routerAdd("POST", "/api/fuloos/net-worth/items", (e) => require(`${__hooks}/integrity_lib.js`).saveItem(e), $apis.requireAuth("fuloos_users"));
routerAdd("POST", "/api/fuloos/net-worth/valuations", (e) => require(`${__hooks}/integrity_lib.js`).valueItem(e), $apis.requireAuth("fuloos_users"));
routerAdd("DELETE", "/api/fuloos/net-worth/snapshots/{id}", (e) => require(`${__hooks}/integrity_lib.js`).removeSnapshot(e), $apis.requireAuth("fuloos_users"));

routerAdd("POST", "/api/fuloos/households/share-account", (e) => require(`${__hooks}/integrity_lib.js`).shareAccount(e), $apis.requireAuth("fuloos_users"));
routerAdd("POST", "/api/fuloos/households/share-budget", (e) => require(`${__hooks}/integrity_lib.js`).shareBudget(e), $apis.requireAuth("fuloos_users"));
