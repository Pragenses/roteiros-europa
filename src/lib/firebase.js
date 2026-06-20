import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";
import { getAuth } from "firebase/auth";
import { getStorage } from "firebase/storage";

const firebaseConfig = {
  apiKey: "AIzaSyAXAtKiMCbo0s4SZbzsU_VRF9M2-5jkjCg",
  authDomain: "roteiros-europa.firebaseapp.com",
  projectId: "roteiros-europa",
  storageBucket: "roteiros-europa.firebasestorage.app",
  messagingSenderId: "1067487729799",
  appId: "1:1067487729799:web:83594151d7be79d8480022"
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const auth = getAuth(app);
export const storage = getStorage(app);
