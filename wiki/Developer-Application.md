# Developer Application

The module talks to the Home Connect API with your own developer application. You need its
**client ID** for `config.js`. This is a one-time setup.

## 1. Create a developer account

Register at the [Home Connect Developer Program](https://developer.home-connect.com/). This account
is separate from the account you use in the Home Connect app.

## 2. Register an application

In the developer portal open **Applications** and choose **Register Application**:

| Field | Value |
| --- | --- |
| Application ID | any name, for example `MagicMirror` |
| OAuth Flow | **Device Flow** |
| Home Connect User Account for Testing | the e-mail address of your **Home Connect app** account (the one your appliances are paired with) |
| Redirect URI | not needed for the device flow |
| One Time Token Mode | leave disabled |

Save the application. A private application only works for the Home Connect account entered as
test account; that is all a mirror at home needs.

## 3. Copy the client ID

Open the application in the list. Copy the **Client ID** into the module config:

```js
config: {
  clientId: "YOUR_CLIENT_ID",
}
```

`clientSecret` is not needed for an application with the device flow. Set it only if the portal shows
the secret as required for your application.

## 4. Wait for activation

A new application is often not accepted right away. If the module shows an error such as
`invalid_client` or `unauthorized_client` directly after you created the application, wait about
15 to 30 minutes and restart MagicMirror.

## 5. Sign in

Start MagicMirror. The module shows a QR code and a short code; continue with
[Authentication](Authentication).

The module only reads appliance states, programs and events. It never sends commands to your
appliances.
