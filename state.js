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

const TOTAL_PARTICIPANTS_TARGET = 10;

const state = {
    view: 'signup',
    isAdminAuthenticated: false,
    participants: [],
    config: {
        historicalPairings: { year1: '', year2: '' },
        emailConfig: { serviceId: '', templateId: '', publicKey: '' },
        admin: { passwordHash: '' }
    }
};

async function loadFromFirebase() {
    try {
        const participantsSnapshot = await getDocs(collection(db, 'participants'));
        state.participants = participantsSnapshot.docs.map(d => ({ id: d.id, ...d.data() }));

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
                },
                admin: {
                    ...state.config.admin,
                    ...(configData.admin || {})
                }
            };
        }

        const storedSession = localStorage.getItem('adminSession');
        if (storedSession && state.config.admin.passwordHash && storedSession === state.config.admin.passwordHash) {
            state.isAdminAuthenticated = true;
        } else {
            localStorage.removeItem('adminSession');
        }
        localStorage.removeItem('adminPassword');
    } catch (error) {
        console.error('Error loading from Firebase:', error);
        throw error;
    }

    return state;
}

async function saveParticipant(participant) {
    const docRef = await addDoc(collection(db, 'participants'), participant);
    participant.id = docRef.id;
    state.participants.push(participant);
    return participant;
}

async function saveConfig() {
    await setDoc(doc(db, 'config', 'settings'), state.config);
}

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

async function clearAllParticipants() {
    const snapshot = await getDocs(collection(db, 'participants'));
    const deletions = snapshot.docs.map(d => deleteDoc(doc(db, 'participants', d.id)));
    await Promise.all(deletions);
    state.participants = [];
    return true;
}

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

async function hashPassword(password) {
    if (window.crypto && window.crypto.subtle) {
        const encoder = new TextEncoder();
        const data = encoder.encode(password);
        const hashBuffer = await window.crypto.subtle.digest('SHA-256', data);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        return hashArray.map(byte => byte.toString(16).padStart(2, '0')).join('');
    }
    return password;
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
    hashPassword
};
