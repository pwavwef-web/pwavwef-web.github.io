import { initializeApp } from 'firebase/app';
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from 'firebase/app-check';
import { browserLocalPersistence, browserPopupRedirectResolver, connectAuthEmulator, indexedDBLocalPersistence, initializeAuth } from 'firebase/auth';
import { connectFunctionsEmulator, getFunctions } from 'firebase/functions';

/**
 * Firebase for the member app (/app). It uses only Auth and the `azsMember` callable — no Firestore or Storage SDK,
 * no studio code. `VITE_MEMBER_*` variables point it at a separate members' project (docs/PUBLIC_PRODUCT_PREP.md);
 * without them it uses the studio's own project, where the beta stays switched off until the owner turns it on.
 */
const env = import.meta.env as Record<string, string | undefined>;
const pick = (k: string) => env[`VITE_MEMBER_${k}`] || env[`VITE_${k}`] || '';

export const memberConfig = {
  apiKey: pick('FIREBASE_API_KEY'),
  authDomain: pick('FIREBASE_AUTH_DOMAIN') || 'az-learner.firebaseapp.com',
  projectId: pick('FIREBASE_PROJECT_ID') || 'az-learner',
  appId: pick('FIREBASE_APP_ID'),
  messagingSenderId: pick('FIREBASE_MESSAGING_SENDER_ID'),
  functionsRegion: pick('FUNCTIONS_REGION') || 'us-central1',
  recaptchaSiteKey: pick('RECAPTCHA_ENTERPRISE_SITE_KEY'),
  useEmulators: env.VITE_USE_EMULATORS === 'true',
};

export const memberConfigProblem = !memberConfig.apiKey || !memberConfig.appId ? 'This build is missing its configuration.' : null;

const app = initializeApp({ apiKey: memberConfig.apiKey || 'missing', authDomain: memberConfig.authDomain, projectId: memberConfig.projectId, appId: memberConfig.appId || 'missing', messagingSenderId: memberConfig.messagingSenderId }, 'az-studio-members');

if (!memberConfig.useEmulators && memberConfig.recaptchaSiteKey && typeof window !== 'undefined') {
  initializeAppCheck(app, { provider: new ReCaptchaEnterpriseProvider(memberConfig.recaptchaSiteKey), isTokenAutoRefreshEnabled: true });
}

export const memberAuth = initializeAuth(app, { persistence: [indexedDBLocalPersistence, browserLocalPersistence], popupRedirectResolver: browserPopupRedirectResolver });
export const memberFunctions = getFunctions(app, memberConfig.functionsRegion);

if (memberConfig.useEmulators) {
  connectAuthEmulator(memberAuth, 'http://127.0.0.1:9099', { disableWarnings: true });
  connectFunctionsEmulator(memberFunctions, '127.0.0.1', 5001);
}
