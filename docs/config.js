// Firebase connection. Leave `firebase` as null to run Movi in demo mode (everything stays in
// this browser). Both values are public and are pasted from the Firebase console:
//   firebase:        Project settings → Your apps → Web app → the firebaseConfig object
//   appCheckSiteKey: App Check → the reCAPTCHA Enterprise site key
// The security rules in the backend repo protect the data, not these values. Never put a secret here.
window.MOVI_CONFIG = {
  firebase: {
    apiKey: "AIzaSyBS9L5-lAQXibNvtXDXDeBDRXVIWRIg7v0",
    authDomain: "combination-23e84.firebaseapp.com",
    projectId: "combination-23e84",
    storageBucket: "combination-23e84.firebasestorage.app",
    messagingSenderId: "102320113071",
    appId: "1:102320113071:web:d14b87d4e52a4f23181b5a",
  },
  appCheckSiteKey: null,
};
