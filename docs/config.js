// Firebase connection. Leave `firebase` as null to run Movi in demo mode (everything stays in
// this browser). Both values are public and are pasted from the Firebase console:
//   firebase:        Project settings → Your apps → Web app → the firebaseConfig object
//   appCheckSiteKey: App Check → the reCAPTCHA Enterprise site key
// The security rules in the backend repo protect the data, not these values. Never put a secret here.
window.MOVI_CONFIG = {
  firebase: null,
  appCheckSiteKey: null,
};
