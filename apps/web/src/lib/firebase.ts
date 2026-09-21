import { initializeApp } from 'firebase/app';
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from 'firebase/app-check';
import { browserLocalPersistence, connectAuthEmulator, indexedDBLocalPersistence, initializeAuth, browserPopupRedirectResolver } from 'firebase/auth';
import { connectFirestoreEmulator, initializeFirestore, persistentLocalCache, persistentMultipleTabManager } from 'firebase/firestore';
import { connectFunctionsEmulator, getFunctions } from 'firebase/functions';
import { connectStorageEmulator, getStorage } from 'firebase/storage';

const env = import.meta.env;

export const config = {
  apiKey: env.VITE_FIREBASE_API_KEY as string,
  authDomain: (env.VITE_FIREBASE_AUTH_DOMAIN as string) || 'az-learner.firebaseapp.com',
  projectId: (env.VITE_FIREBASE_PROJECT_ID as string) || 'az-learner',
  appId: env.VITE_FIREBASE_APP_ID as string,
  messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID as string,
  firestoreDatabase: (env.VITE_FIRESTORE_DATABASE as string) || 'az-studio',
  mediaBucket: (env.VITE_MEDIA_BUCKET as string) || 'az-studio-media-az-learner',
  functionsRegion: (env.VITE_FUNCTIONS_REGION as string) || 'us-central1',
  recaptchaSiteKey: env.VITE_RECAPTCHA_ENTERPRISE_SITE_KEY as string,
  useEmulators: env.VITE_USE_EMULATORS === 'true',
};

export const configProblem = !config.apiKey || !config.appId ? 'This build is missing its Firebase configuration. Run `npm run web:env` before building.' : null;

export const app = initializeApp({
  apiKey: config.apiKey || 'missing',
  authDomain: config.authDomain,
  projectId: config.projectId,
  appId: config.appId || 'missing',
  messagingSenderId: config.messagingSenderId,
  storageBucket: config.mediaBucket,
});

// App Check (reCAPTCHA Enterprise). The owner-only API rejects requests without a valid token.
if (!config.useEmulators && config.recaptchaSiteKey && typeof window !== 'undefined') {
  initializeAppCheck(app, { provider: new ReCaptchaEnterpriseProvider(config.recaptchaSiteKey), isTokenAutoRefreshEnabled: true });
}

export const auth = initializeAuth(app, {
  persistence: [indexedDBLocalPersistence, browserLocalPersistence],
  popupRedirectResolver: browserPopupRedirectResolver,
});

export const db = initializeFirestore(
  app,
  { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }), ignoreUndefinedProperties: true },
  config.firestoreDatabase,
);

export const storage = getStorage(app, `gs://${config.mediaBucket}`);
export const functions = getFunctions(app, config.functionsRegion);

if (config.useEmulators) {
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  connectFirestoreEmulator(db, '127.0.0.1', 8080);
  connectStorageEmulator(storage, '127.0.0.1', 9199);
  connectFunctionsEmulator(functions, '127.0.0.1', 5001);
}
