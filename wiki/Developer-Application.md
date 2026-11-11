# Developer Application

The module talks to the Home Connect API with your own developer application. You need its
**client ID** for `config.js`. This is a one-time setup.

## 1. Create a developer account

Register at the [Home Connect Developer Program](https://developer.home-connect.com/). This account
is separate from the account you use in the Home Connect app.

## 2. Register an application

In the developer portal open the applications overview and register a new application. The labels
below follow the portal; they may differ slightly:

| Field | Value |
| --- | --- |
| Name / Application ID | any name, for example `MagicMirror` |
| OAuth Flow | **Device Flow** |
| Home Connect user account for testing | the e-mail address of your **Home Connect app** account (the one your appliances are paired with) |
| Redirect URIs | not used by the device flow |
| One Time Token Mode | leave disabled |
| Proof Key for Code Exchange | leave disabled (only for the authorization code flow) |

Save the application. Its access is **private**: it only works for the Home Connect account entered as
test account, which is all a mirror at home needs.

## 3. Copy the client ID

Open the application in the list. Copy the **Client ID** into the module config:

```js
config: {
  clientId: "YOUR_CLIENT_ID",
}
```

The portal shows a **Client Secret** next to it. The device flow works without it, but Home Connect
recommends sending it; set it as `clientSecret` (see [Security](Security) for keeping it out of the
browser). The module then sends it with every token request.

## 4. If the login is refused

`unauthorized_client` in the module or on the login page usually means one of these:

- the client ID is wrong or incomplete (it is 64 characters long);
- the application was registered for another OAuth flow - it must be **Device Flow**;
- you signed in with a Home Connect account that is not the application's test account;
- `clientSecret` is set but does not belong to this application.

A new application is sometimes not accepted right away. If everything above is right, wait a few
minutes and restart MagicMirror.

## 5. Sign in

Start MagicMirror. The module shows a QR code and a short code; continue with
[Authentication](Authentication).

The module only reads appliance states, programs and events. It never sends commands to your
appliances.
