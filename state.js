import {
    db,
    collection,
    getDocs,
    addDoc,
    updateDoc,
    doc,
    setDoc,
    getDoc,
    deleteDoc
} from './firebase.js';

// ===== Shared state and persistence =====

const TOTAL_PARTICIPANTS_TARGET = 10;

const participantCountDocRef = doc(db, 'stats', 'participants');

// Centralized app state that every module reads/writes.
const state = {
    view: 'signup',
    isAdminAuthenticated: false,
    adminEmail: '',
    adminMessage: { text: '', type: 'info' },
    participants: [],
    pendingAssignments: null,
    previewAssignmentsVisible: false,
    signupComplete: false,
    lastSignupName: '',
    signupInFlight: false,
    signupMessage: { text: '', type: 'info' },
    signupFormDraft: {
        name: '',
        email: '',
        wishlist: '',
        spouseName: '',
        quickPick1: '',
        quickPick2: '',
        quickPick3: '',
        quickPick1Link: '',
        quickPick2Link: '',
        quickPick3Link: ''
    },
    participantCount: null,
    participantCountKnown: false,
    config: {
        historicalPairings: { year1: '', year2: '' },
        emailConfig: { serviceId: '', templateId: '', publicKey: '' }
    }
};

// Pulls config plus (optionally) participant data from Firestore.
async function loadFromFirebase(options = {}) {
    const { fetchParticipants = false } = options;
    try {
        const configDoc = await getDoc(doc(db, 'config', 'settings'));
        if (configDoc.exists()) {
            const configData = configDoc.data();
            state.config = {
                ...state.config,
                ...configData,
                historicalPairings: {
                    ...state.config.historicalPairings,
                    ...(configData.historicalPairings || {})
                },
                emailConfig: {
                    ...state.config.emailConfig,
                    ...(configData.emailConfig || {})
                }
            };
        }
    } catch (error) {
        console.error('Error loading config from Firebase:', error);
        throw error;
    }

    try {
        const countDoc = await getDoc(participantCountDocRef);
        if (countDoc.exists()) {
            const countData = countDoc.data();
            const countValue = typeof countData.participantCount === 'number'
                ? countData.participantCount
                : parseInt(countData.participantCount, 10);
            if (Number.isFinite(countValue)) {
                state.participantCount = countValue;
                state.participantCountKnown = true;
            } else {
                state.participantCount = null;
                state.participantCountKnown = false;
            }
        } else {
            state.participantCount = null;
            state.participantCountKnown = false;
        }
    } catch (error) {
        console.error('Error loading participant count from Firebase:', error);
        state.participantCount = null;
        state.participantCountKnown = false;
    }

    if (fetchParticipants) {
        state.participants = [];
        try {
            const participantsSnapshot = await getDocs(collection(db, 'participants'));
            state.participants = participantsSnapshot.docs.map(d => ({ id: d.id, ...d.data() }));
            state.pendingAssignments = null;
            state.previewAssignmentsVisible = false;
        } catch (error) {
            if (error.code === 'permission-denied') {
                state.participants = [];
            } else {
                console.error('Error loading participants from Firebase:', error);
                throw error;
            }
        }
    }

    return state;
}

// Saves a new participant document and updates local state.
async function saveParticipant(participant) {
    console.log('Submitting participant payload:', JSON.stringify(participant));
    const docRef = await addDoc(collection(db, 'participants'), participant);
    participant.id = docRef.id;
    state.participants.push(participant);
    return participant;
}

// Writes config changes back to Firestore (with dot-path support).
function updateConfig(field, value) {
    if (field.includes('.')) {
        const [obj, key] = field.split('.');
        if (!state.config[obj]) {
            state.config[obj] = {};
        }
        state.config[obj][key] = value;
    } else if (['serviceId', 'templateId', 'publicKey'].includes(field)) {
        state.config.emailConfig[field] = value;
    } else {
        state.config[field] = value;
    }
    return saveConfig();
}

// Persists the current config object.
async function saveConfig() {
    await setDoc(doc(db, 'config', 'settings'), state.config);
}

// Removes every participant record (used for testing resets).
async function clearAllParticipants() {
    const snapshot = await getDocs(collection(db, 'participants'));
    const deletions = snapshot.docs.map(d => deleteDoc(doc(db, 'participants', d.id)));
    await Promise.all(deletions);
    state.participants = [];
    state.pendingAssignments = null;
    state.previewAssignmentsVisible = false;
    state.signupComplete = false;
    state.lastSignupName = '';
    state.signupInFlight = false;
    state.signupMessage = { text: '', type: 'info' };
    state.participantCount = null;
    state.participantCountKnown = true;
    return true;
}

// Parses historical pairing text into giver/receiver objects.
function parseHistoricalPairings() {
    const pairings = [];
    [state.config.historicalPairings.year1, state.config.historicalPairings.year2].forEach(yearData => {
        if (!yearData || !yearData.trim()) return;
        const pairs = yearData.split(/[,\n]/).map(p => p.trim()).filter(p => p);
        pairs.forEach(pair => {
            const match = pair.match(/(.+?)\s*[-→>]\s*(.+)/);
            if (match) {
                pairings.push({ giver: match[1].trim(), receiver: match[2].trim() });
            }
        });
    });
    return pairings;
}

// Updates admin flags/email based on the authenticated user and claims.
function setAdminAuth(user, claims = {}) {
    const isAdmin = !!(user && claims.admin);
    state.isAdminAuthenticated = isAdmin;
    state.adminEmail = isAdmin ? (user.email || '') : '';
    if (!isAdmin) {
        state.pendingAssignments = null;
        state.previewAssignmentsVisible = false;
        state.adminMessage = { text: '', type: 'info' };
        state.signupComplete = false;
        state.lastSignupName = '';
        state.signupInFlight = false;
        state.signupMessage = { text: '', type: 'info' };
        state.signupFormDraft = {
            name: '',
            email: '',
            wishlist: '',
            spouseName: '',
            quickPick1: '',
            quickPick2: '',
            quickPick3: '',
            quickPick1Link: '',
            quickPick2Link: '',
            quickPick3Link: ''
        };
    }
}

async function fetchParticipantCount() {
    try {
        const snapshot = await getDoc(participantCountDocRef);
        if (snapshot.exists()) {
            const data = snapshot.data();
            const countValue = typeof data.participantCount === 'number'
                ? data.participantCount
                : parseInt(data.participantCount, 10);
            if (Number.isFinite(countValue)) {
                state.participantCount = countValue;
                state.participantCountKnown = true;
                return countValue;
            }
        }
        state.participantCount = null;
        state.participantCountKnown = false;
        return null;
    } catch (error) {
        state.participantCount = null;
        state.participantCountKnown = false;
        throw error;
    }
}

async function persistParticipantCount(count) {
    await setDoc(
        participantCountDocRef,
        {
            participantCount: count,
            updatedAt: Date.now()
        },
        { merge: true }
    );
    state.participantCount = count;
    state.participantCountKnown = true;
    return count;
}

export {
    state,
    TOTAL_PARTICIPANTS_TARGET,
    loadFromFirebase,
    saveParticipant,
    saveConfig,
    updateConfig,
    clearAllParticipants,
    parseHistoricalPairings,
    setAdminAuth,
    fetchParticipantCount,
    persistParticipantCount
};
