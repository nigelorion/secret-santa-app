import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js';
import {
    initializeFirestore,
    collection,
    getDocs,
    addDoc,
    updateDoc,
    doc,
    setDoc,
    getDoc,
    deleteDoc
} from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js';
import {
    getAuth,
    signInWithEmailAndPassword,
    signOut,
    onAuthStateChanged
} from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js';

const firebaseConfig = {
    apiKey: 'AIzaSyD_w3zUhizJZsjdtrzTkq_lAePsvAFVM_o',
    authDomain: 'secret-manta-ff7b6.firebaseapp.com',
    projectId: 'secret-manta-ff7b6',
    storageBucket: 'secret-manta-ff7b6.firebasestorage.app',
    messagingSenderId: '138324851995',
    appId: '1:138324851995:web:e82a5ec02d2e81c0e6e7be',
    measurementId: 'G-5D1MW1MP7C'
};

const app = initializeApp(firebaseConfig);
const db = initializeFirestore(app, {
    experimentalAutoDetectLongPolling: true,
    useFetchStreams: false
});
const auth = getAuth(app);

export {
    db,
    collection,
    getDocs,
    addDoc,
    updateDoc,
    doc,
    setDoc,
    getDoc,
    deleteDoc,
    auth,
    signInWithEmailAndPassword,
    signOut,
    onAuthStateChanged
};
