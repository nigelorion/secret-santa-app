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

const firebaseConfig = {
    apiKey: 'AIzaSyD_w3zUhizJZsjdtrzTkq_lAePsvAFVM_o',
    authDomain: 'secret-manta-ff7b6.firebaseapp.com',
    projectId: 'secret-manta-ff7b6',
    storageBucket: 'secret-manta-ff7b6.firebasestorage.app',
    messagingSenderId: '138324851995',
    appId: '1:138324851995:web:e82a5ec02d2e81c0e6e7be',
    measurementId: 'G-5D1MW1MP7C'
};

const TOTAL_PARTICIPANTS_TARGET = 10;

const app = initializeApp(firebaseConfig);
const db = initializeFirestore(app, {
    experimentalAutoDetectLongPolling: true,
    useFetchStreams: false
});

window.db = db;

function handleFocusScroll(event) {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    if (!['INPUT', 'TEXTAREA'].includes(target.tagName)) return;
    if (window.innerWidth > 900) return;
    setTimeout(() => {
        target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }, 120);
}

document.addEventListener('focusin', handleFocusScroll);

function triggerCelebration() {
    const overlay = document.createElement('div');
    overlay.className = 'celebration-overlay';
    const flakes = Array.from({ length: 50 }).map(() => {
        const left = Math.random() * 100;
        const duration = 6 + Math.random() * 4;
        const delay = Math.random() * 0.6;
        const drift = (Math.random() * 40 - 20).toFixed(2) + 'vw';
        const scale = 0.8 + Math.random() * 0.6;
        return `<div class="flake" style="left:${left}vw; animation-duration:${duration}s; animation-delay:${delay}s; --drift:${drift}; transform:scale(${scale});">❄️</div>`;
    }).join('');
    overlay.innerHTML = flakes;
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('active'));
    setTimeout(() => overlay.classList.add('fade'), 5500);
    setTimeout(() => overlay.remove(), 6500);
}

window.triggerCelebration = triggerCelebration;

function getDaysUntilChristmas() {
    const now = new Date();
    const currentYear = now.getFullYear();
    const christmas = new Date(currentYear, 11, 25);
    if (now > christmas) {
        christmas.setFullYear(currentYear + 1);
    }
    const diff = christmas - now;
    return Math.max(0, Math.ceil(diff / (1000 * 60 * 60 * 24)));
}

window.getDaysUntilChristmas = getDaysUntilChristmas;

function getDaysUntilChristmasLocal() {
    return getDaysUntilChristmas();
}

let state = {
    view: 'signup',
    isAdminAuthenticated: false,
    participants: [],
    config: {
        historicalPairings: { year1: '', year2: '' },
        emailConfig: { serviceId: '', templateId: '', publicKey: '' },
        admin: { passwordHash: '' }
    }
};

window.initApp = async function() {
    await loadFromFirebase();
    render();
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
        updateProgressBar();
        updateCountdown();
    } catch (error) {
        console.error('Error loading from Firebase:', error);
    }
}

async function saveParticipant(participant) {
    try {
        const docRef = await addDoc(collection(db, 'participants'), participant);
        participant.id = docRef.id;
        state.participants.push(participant);
    } catch (error) {
        console.error('Error saving participant:', error);
        throw error;
    }
}

async function saveConfig() {
    try {
        await setDoc(doc(db, 'config', 'settings'), state.config);
    } catch (error) {
        console.error('Error saving config:', error);
    }
}

function showMessage(message, type) {
    const typeClass = type === 'success' ? 'success' : type === 'error' ? 'error' : 'info';
    return `<div class="message ${typeClass}">${message}</div>`;
}

function showView(view) {
    state.view = view;
    const adminTab = document.getElementById('adminTab');
    if (adminTab) {
        adminTab.classList.toggle('admin-entry-active', view === 'admin' || view === 'admin-login');
    }
    render();
}

function toggleQuickPicks(forceOpen) {
    const section = document.getElementById('quickPicksSection');
    const toggleButton = document.getElementById('quickPicksToggle');
    if (!section || !toggleButton) return;
    const shouldOpen = typeof forceOpen === 'boolean' ? forceOpen : !section.classList.contains('open');
    section.classList.toggle('open', shouldOpen);
    toggleButton.classList.toggle('active', shouldOpen);
    toggleButton.textContent = shouldOpen ? '− Hide quick picks' : '➕ Add quick picks (optional)';
    const inputs = section.querySelectorAll('input');
    inputs.forEach(input => { input.disabled = !shouldOpen; });
}

function updateProgressBar() {
    const total = TOTAL_PARTICIPANTS_TARGET || 1;
    const signed = state.participants.length;
    const percentBase = total ? Math.min(signed, total) : signed;
    const percent = Math.min(100, total ? (percentBase / total) * 100 : 100);
    const remaining = Math.max(0, total - signed);
    const primaryLabel = remaining > 0
        ? `${signed}/${total} signed up • ${remaining} to go`
        : `${signed}/${total} signed up • Everyone's in!`;

    const fill = document.getElementById('progressFill');
    const label = document.getElementById('progressLabel');
    const text = document.getElementById('progressText');
    if (fill) fill.style.width = `${percent}%`;
    if (label) label.textContent = primaryLabel;
    if (text) text.textContent = `${signed} of ${total} have already shared their wish lists`;

    const adminFill = document.getElementById('adminProgressFill');
    const adminLabel = document.getElementById('adminProgressLabel');
    const adminText = document.getElementById('adminProgressText');
    if (adminFill) adminFill.style.width = `${percent}%`;
    if (adminLabel) {
        const adminTextContent = remaining > 0
            ? `${signed}/${total} signed up (${remaining} left)`
            : `${signed}/${total} signed up (All set)`;
        adminLabel.textContent = adminTextContent;
    }
    if (adminText) {
        adminText.textContent = `${signed} of ${total} have submitted their wish lists`;
    }
}

function updateCountdown() {
    const days = getDaysUntilChristmasLocal();
    state.daysUntilChristmas = days;
    let message = '🎄 Christmas is here!';
    if (days > 1) {
        message = `🎅 ${days} days until Christmas`;
    } else if (days === 1) {
        message = '🎅 1 day until Christmas';
    } else if (days === 0) {
        message = '🎄 It\'s Christmas Day!';
    }

    const countdownBox = document.getElementById('countdownBox');
    if (countdownBox) countdownBox.textContent = message;

    const adminCountdown = document.getElementById('adminCountdown');
    if (adminCountdown) adminCountdown.textContent = message;
}

async function handleSignup(event) {
    event.preventDefault();
    const form = event.target;
    const formData = new FormData(form);
    const name = (formData.get('name') || '').trim();
    const email = (formData.get('email') || '').trim();
    const wishlist = (formData.get('wishlist') || '').trim();
    const spouseName = (formData.get('spouseName') || '').trim();
    const quickPick1 = (formData.get('quickPick1') || '').trim();
    const quickPick2 = (formData.get('quickPick2') || '').trim();
    const quickPick3 = (formData.get('quickPick3') || '').trim();
    const quickPick1Link = (formData.get('quickPick1Link') || '').trim();
    const quickPick2Link = (formData.get('quickPick2Link') || '').trim();
    const quickPick3Link = (formData.get('quickPick3Link') || '').trim();

    if (typeof navigator !== 'undefined' && navigator && 'onLine' in navigator && !navigator.onLine) {
        document.getElementById('signupMessage').innerHTML = showMessage('Looks like you\'re offline. Reconnect to the internet, then try signing up again.', 'error');
        return;
    }

    const requiredMissing = [];
    if (!name) requiredMissing.push('your name');
    if (!email) requiredMissing.push('your email');
    if (!spouseName) requiredMissing.push('your spouse\'s name');

    if (requiredMissing.length) {
        document.getElementById('signupMessage').innerHTML = showMessage(`Please fill out ${requiredMissing.join(', ')} before signing up.`, 'error');
        return;
    }

    if (state.participants.some(p => p.email.toLowerCase() === email.toLowerCase() || p.name.toLowerCase() === name.toLowerCase())) {
        document.getElementById('signupMessage').innerHTML = showMessage('Oops! You are already signed up this year. If you need to update your info, contact the organizer.', 'error');
        return;
    }

    try {
        await saveParticipant({
            name,
            email,
            wishlist,
            spouseName,
            quickPicks: [
                { title: quickPick1, link: quickPick1Link },
                { title: quickPick2, link: quickPick2Link },
                { title: quickPick3, link: quickPick3Link }
            ].filter(item => item.title || item.link),
            timestamp: Date.now()
        });
    } catch (error) {
        console.error('Signup error (saving participant):', error);
        document.getElementById('signupMessage').innerHTML = showMessage('We couldn\'t save your info. Check your connection and try again.', 'error');
        return;
    }

    try {
        form.reset();
        toggleQuickPicks(false);
        updateProgressBar();
        updateCountdown();
        document.getElementById('signupMessage').innerHTML = showMessage('🎉 Successfully signed up! You\'ll receive an email once Secret Santa assignments are made.', 'success');
        const topAnchor = document.getElementById('signupFormTop');
        if (topAnchor) {
            topAnchor.scrollIntoView({ behavior: 'smooth', block: 'start' });
        } else {
            window.scrollTo({ top: 0, behavior: 'smooth' });
        }
        triggerCelebration();
    } catch (uiError) {
        console.error('Signup UI update error:', uiError);
        document.getElementById('signupMessage').innerHTML = showMessage('You\'re signed up, but we hit a snag updating the page. Refresh to double-check your info.', 'info');
    }
}

function scrollToSignup() {
    const navigate = () => {
        const anchor = document.getElementById('signupFormTop');
        if (anchor) {
            anchor.scrollIntoView({ behavior: 'smooth', block: 'start' });
        } else {
            window.scrollTo({ top: 0, behavior: 'smooth' });
        }
    };

    if (state.view !== 'signup') {
        showView('signup');
        setTimeout(navigate, 150);
    } else {
        navigate();
    }
}

async function handleAdminLogin(event) {
    event.preventDefault();
    const passwordInput = document.getElementById('passwordInput');
    const password = passwordInput.value.trim();
    const messageContainer = document.getElementById('adminLoginMessage');

    if (!password) {
        if (messageContainer) {
            messageContainer.innerHTML = showMessage('Please enter your password.', 'error');
        }
        return;
    }

    if (!state.config.admin.passwordHash) {
        if (messageContainer) {
            messageContainer.innerHTML = showMessage('Admin password is not configured. Please contact the organizer to set it up in Firebase.', 'error');
        }
        return;
    }

    try {
        const hashed = await hashPassword(password);
        if (hashed === state.config.admin.passwordHash) {
            state.isAdminAuthenticated = true;
            localStorage.setItem('adminSession', hashed);
            passwordInput.value = '';
            if (messageContainer) {
                messageContainer.innerHTML = showMessage('Access granted.', 'success');
            }
            showView('admin');
        } else if (messageContainer) {
            messageContainer.innerHTML = showMessage('Incorrect password. Please try again.', 'error');
        }
    } catch (error) {
        console.error('Admin login error:', error);
        if (messageContainer) {
            messageContainer.innerHTML = showMessage('Unable to verify password in this browser.', 'error');
        }
    }
}

async function handleChangePassword(event) {
    event.preventDefault();
    const form = event.target;
    const currentPassword = form.currentPassword.value.trim();
    const newPassword = form.newPassword.value.trim();
    const confirmPassword = form.confirmPassword.value.trim();
    const messageContainer = document.getElementById('adminMessage');

    if (!newPassword || newPassword.length < 6) {
        if (messageContainer) {
            messageContainer.innerHTML = showMessage('New password must be at least 6 characters long.', 'error');
        }
        return;
    }

    if (newPassword !== confirmPassword) {
        if (messageContainer) {
            messageContainer.innerHTML = showMessage('New password and confirmation do not match.', 'error');
        }
        return;
    }

    try {
        const currentHash = await hashPassword(currentPassword);
        if (state.config.admin.passwordHash && currentHash !== state.config.admin.passwordHash) {
            if (messageContainer) {
                messageContainer.innerHTML = showMessage('Current password is incorrect.', 'error');
            }
            return;
        }

        const newHash = await hashPassword(newPassword);
        state.config.admin.passwordHash = newHash;
        await saveConfig();
        localStorage.setItem('adminSession', newHash);
        form.reset();

        if (messageContainer) {
            messageContainer.innerHTML = showMessage('Admin password updated successfully.', 'success');
        }
    } catch (error) {
        console.error('Password update error:', error);
        if (messageContainer) {
            messageContainer.innerHTML = showMessage('Could not update password. Please try again.', 'error');
        }
    }
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

async function runSecretSanta() {
    if (state.participants.length < 3) {
        document.getElementById('adminMessage').innerHTML = showMessage('Need at least 3 participants!', 'error');
        return;
    }

    if (!state.config.emailConfig.serviceId || !state.config.emailConfig.templateId || !state.config.emailConfig.publicKey) {
        document.getElementById('adminMessage').innerHTML = showMessage('Please configure EmailJS settings first!', 'error');
        return;
    }

    const historicalPairs = parseHistoricalPairings();
    const spouseMap = {};
    state.participants.forEach(p => {
        if (p.spouseName) {
            spouseMap[p.name] = p.spouseName;
            spouseMap[p.spouseName] = p.name;
        }
    });

    const shuffled = [...state.participants].sort(() => Math.random() - 0.5);
    const assignments = [];
    const available = [...shuffled];

    for (const giver of shuffled) {
        const receiverIndex = available.findIndex(r => {
            if (r.name === giver.name) return false;
            const giverSpouse = spouseMap[giver.name];
            if (giverSpouse && r.name.toLowerCase() === giverSpouse.toLowerCase()) return false;

            const recentReceivers = historicalPairs
                .filter(p => p.giver.toLowerCase() === giver.name.toLowerCase())
                .map(p => p.receiver.toLowerCase());

            if (recentReceivers.includes(r.name.toLowerCase())) return false;
            return true;
        });

        if (receiverIndex === -1) {
            document.getElementById('adminMessage').innerHTML = showMessage('Could not create valid assignments with current constraints. Try again!', 'error');
            return;
        }

        const receiver = available[receiverIndex];
        assignments.push({ giver, receiver });
        available.splice(receiverIndex, 1);
    }

    await sendEmails(assignments);
}

async function sendEmails(assignments) {
    try {
        emailjs.init(state.config.emailConfig.publicKey);

        document.getElementById('adminMessage').innerHTML = showMessage('Sending emails...', 'info');

        let successCount = 0;
        let failCount = 0;
        const daysUntilChristmas = getDaysUntilChristmasLocal();
        const countdownLine = daysUntilChristmas > 1
            ? `${daysUntilChristmas} days until Christmas`
            : daysUntilChristmas === 1
                ? '1 day until Christmas'
                : 'Christmas is here!';

        for (const assignment of assignments) {
            try {
                const quickPicks = (assignment.receiver.quickPicks || []).slice(0, 3).map(item => {
                    const hasTitle = item && item.title;
                    const hasLink = item && item.link;
                    if (hasTitle && hasLink) {
                        return `${item.title} — ${item.link}`;
                    }
                    if (hasTitle) return item.title;
                    if (hasLink) return item.link;
                    return '';
                }).filter(Boolean).join('\n');

                await emailjs.send(
                    state.config.emailConfig.serviceId,
                    state.config.emailConfig.templateId,
                    {
                        to_name: assignment.giver.name,
                        to_email: assignment.giver.email,
                        receiver_name: assignment.receiver.name,
                        receiver_wishlist: assignment.receiver.wishlist || 'No wish list provided yet',
                        receiver_quick_picks: quickPicks || 'Surprise them—no quick picks added!',
                        countdown_to_christmas: countdownLine
                    }
                );
                successCount++;
            } catch (error) {
                console.error(`Failed to send email to ${assignment.giver.name}:`, error);
                failCount++;
            }
        }

        if (failCount === 0) {
            document.getElementById('adminMessage').innerHTML = showMessage(`🎉 Success! ${successCount} Secret Santa emails have been sent! Check your inbox for your assignment!`, 'success');
        } else {
            document.getElementById('adminMessage').innerHTML = showMessage(`⚠️ Partially complete: ${successCount} emails sent, ${failCount} failed. Check console for details.`, 'error');
        }
    } catch (error) {
        console.error('Email sending error:', error);
        document.getElementById('adminMessage').innerHTML = showMessage('❌ Failed to send emails. Please check your EmailJS configuration and try again.', 'error');
    }
}

async function clearAllParticipants() {
    if (!state.isAdminAuthenticated) return;
    const confirmed = window.confirm('This will remove everyone who has signed up. Continue?');
    if (!confirmed) return;

    try {
        if (state.participants.length === 0) {
            const currentMessage = document.getElementById('adminMessage');
            if (currentMessage) {
                currentMessage.innerHTML = showMessage('There aren\'t any sign-ups to clear right now.', 'info');
            }
            return;
        }
        const snapshot = await getDocs(collection(db, 'participants'));
        const deletions = snapshot.docs.map(d => deleteDoc(doc(db, 'participants', d.id)));
        await Promise.all(deletions);
        state.participants = [];
        updateProgressBar();
        render();
        const messageContainer = document.getElementById('adminMessage');
        if (messageContainer) {
            messageContainer.innerHTML = showMessage('Cleared all participants for testing.', 'info');
        }
    } catch (error) {
        console.error('Error clearing participants:', error);
        const messageContainer = document.getElementById('adminMessage');
        if (messageContainer) {
            messageContainer.innerHTML = showMessage('Unable to clear participants. Try again in a moment.', 'error');
        }
    }
}

async function updateConfig(field, value) {
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
    await saveConfig();
}

function render() {
    const content = document.getElementById('content');
    if (!content) return;

    if (state.view === 'signup') {
        content.innerHTML = `
            <div id="signupFormTop"></div>
            <div class="countdown-box" id="countdownBox">Loading countdown...</div>
            <div class="progress-grid">
                <div class="progress-bar" id="progressBar">
                    <div class="progress-fill" id="progressFill" style="width:0%"></div>
                    <span id="progressLabel"></span>
                </div>
                <p class="progress-text" id="progressText"></p>
            </div>
            <p class="intro-text">Fill this out once and we’ll take care of the rest—share who you are, what you love, and we’ll handle the match-up magic.</p>
            <div id="signupMessage"></div>
            <form id="signupForm" onsubmit="handleSignup(event); return false;">
                <div>
                    <label>YOUR NAME *</label>
                    <input type="text" name="name" placeholder="ENTER NAME">
                </div>
                <div>
                    <label>YOUR EMAIL *</label>
                    <input type="email" name="email" placeholder="ENTER EMAIL">
                </div>
                <div>
                    <label>WISH LIST LETTER</label>
                    <textarea name="wishlist" rows="5" placeholder="Say hi to your Santa, share what you're into this season, and mention any themes or surprises you'd love."></textarea>
                </div>
                <button type="button" class="toggle-quick-picks" id="quickPicksToggle" onclick="toggleQuickPicks()">➕ Add quick picks (optional)</button>
                <div class="section-box quick-picks" id="quickPicksSection">
                    <h3 style="margin-bottom:12px; color:#f5d67b;">QUICK PICKS</h3>
                    <p class="helper-text" style="margin-bottom:10px;">Add up to three specific ideas or product links in case your Santa needs a nudge.</p>
                    <div style="display:grid; gap:12px;">
                        <div style="display:grid; gap:8px;">
                            <label style="margin-bottom:0;">ITEM 1 TITLE</label>
                            <input type="text" name="quickPick1" placeholder="Example: Cozy flannel pajamas" disabled>
                            <input type="url" name="quickPick1Link" placeholder="https://example.com/flannel-set" disabled>
                        </div>
                        <div style="display:grid; gap:8px;">
                            <label style="margin-bottom:0;">ITEM 2 TITLE</label>
                            <input type="text" name="quickPick2" placeholder="Example: Cookbook from my wish list" disabled>
                            <input type="url" name="quickPick2Link" placeholder="https://example.com/cookbook" disabled>
                        </div>
                        <div style="display:grid; gap:8px;">
                            <label style="margin-bottom:0;">ITEM 3 TITLE</label>
                            <input type="text" name="quickPick3" placeholder="Example: Local coffee shop gift card" disabled>
                            <input type="url" name="quickPick3Link" placeholder="https://example.com/gift-card" disabled>
                        </div>
                    </div>
                </div>
                <div>
                    <label>SPOUSE NAME *</label>
                    <input type="text" name="spouseName" placeholder="Spouse's name (no matching together)">
                </div>
                <button type="submit">SIGN ME UP! 🎅</button>
            </form>
        `;
        toggleQuickPicks(false);
        setTimeout(() => {
            const topAnchor = document.getElementById('signupFormTop');
            if (topAnchor) {
                topAnchor.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }
        }, 100);
    } else if (state.view === 'admin-login' && !state.isAdminAuthenticated) {
        const hasPassword = Boolean(state.config.admin.passwordHash);
        content.innerHTML = `
            <h2>ADMIN LOGIN</h2>
            <div id="adminLoginMessage"></div>
            <form onsubmit="handleAdminLogin(event); return false;">
                <p class="helper-text" style="margin-bottom: 20px;">${hasPassword ? 'Enter the secret password to access the admin dashboard.' : 'No admin password is set. Configure one securely in Firebase before enabling access.'}</p>
                <input type="password" id="passwordInput" ${hasPassword ? '' : 'disabled'} required placeholder="${hasPassword ? 'ENTER PASSWORD' : 'PASSWORD NOT CONFIGURED'}">
                <button type="submit" ${hasPassword ? '' : 'disabled'}>
                    LOGIN
                </button>
            </form>
            <button type="button" class="button-secondary" onclick="showView('signup')" style="margin-top:16px;width:auto;padding:10px 18px;">⬅ BACK TO SIGN UP</button>
        `;
    } else if (state.isAdminAuthenticated && (state.view === 'admin' || state.view === 'admin-login')) {
        state.view = 'admin';
        const participantsList = state.participants.length === 0
            ? '<p class="helper-text">NO PARTICIPANTS YET</p>'
            : state.participants.map(p => {
                const name = escapeHtml(p.name);
                const email = escapeHtml(p.email);
                const spouse = p.spouseName ? escapeHtml(p.spouseName) : '';
                const quickPicksHtml = (p.quickPicks && p.quickPicks.length)
                    ? `<ul>${p.quickPicks.map((item, index) => {
                        if (!item || (!item.title && !item.link)) return '';
                        const title = item.title ? escapeHtml(item.title) : `Item ${index + 1}`;
                        const link = item.link ? encodeURI(item.link) : '';
                        if (link) {
                            return `<li>${title} — <a href="${link}" target="_blank" rel="noopener">view link</a></li>`;
                        }
                        return `<li>${title}</li>`;
                    }).filter(Boolean).join('')}</ul>`
                    : '';

                return `
                    <div class="participant-card">
                        <p><strong>${name}</strong></p>
                        <p>${email}</p>
                        ${spouse ? `<p>SPOUSE: ${spouse}</p>` : ''}
                        ${quickPicksHtml ? `<p style="margin-top:8px; font-weight:600;">Quick Picks</p>${quickPicksHtml}` : ''}
                    </div>
                `;
            }).join('');

        content.innerHTML = `
            <h2>ADMIN PANEL</h2>
            <div class="countdown-box" id="adminCountdown">Loading countdown...</div>
            <div class="progress-grid">
                <div class="progress-bar" id="adminProgressBar">
                    <div class="progress-fill" id="adminProgressFill" style="width:0%"></div>
                    <span id="adminProgressLabel"></span>
                </div>
                <p class="progress-text" id="adminProgressText"></p>
            </div>
            <button type="button" class="button-secondary" onclick="showView('signup')" style="margin-bottom:18px;width:auto;padding:10px 18px;">⬅ BACK TO SIGN UP</button>
            <div id="adminMessage"></div>

            <div style="margin-bottom: 30px;">
                <h3>PARTICIPANTS (${state.participants.length})</h3>
                ${participantsList}
                <button type="button" class="button-secondary" onclick="clearAllParticipants()">🧹 CLEAR ALL SIGNUPS</button>
                <p class="helper-text" style="margin-top:8px;">Testing helper: removes everyone so you can start fresh.</p>
            </div>

            <div class="section-box yellow">
                <h3>HISTORICAL PAIRINGS</h3>
                <p class="helper-text" style="margin-bottom: 15px;">ENTER PREVIOUS YEARS' ASSIGNMENTS TO AVOID REPEATS<br>FORMAT: "GIVER → RECEIVER" OR "GIVER - RECEIVER"</p>
                <div>
                    <label>2023 PAIRINGS</label>
                    <textarea onchange="updateConfig('historicalPairings.year1', this.value)" rows="2" placeholder="JOHN → SARAH, MARY → TOM">${state.config.historicalPairings.year1 || ''}</textarea>
                </div>
                <div>
                    <label>2024 PAIRINGS</label>
                    <textarea onchange="updateConfig('historicalPairings.year2', this.value)" rows="2" placeholder="JOHN → MARY, SARAH → JOHN">${state.config.historicalPairings.year2 || ''}</textarea>
                </div>
            </div>

            <div class="section-box blue">
                <h3>EMAILJS CONFIGURATION</h3>
                <p class="helper-text" style="margin-bottom: 15px;">ENTER YOUR EMAILJS CREDENTIALS</p>
                <div>
                    <label>SERVICE ID</label>
                    <input type="text" value="${state.config.emailConfig.serviceId || ''}" onchange="updateConfig('serviceId', this.value)" placeholder="SERVICE_ID">
                </div>
                <div>
                    <label>TEMPLATE ID</label>
                    <input type="text" value="${state.config.emailConfig.templateId || ''}" onchange="updateConfig('templateId', this.value)" placeholder="TEMPLATE_ID">
                </div>
                <div>
                    <label>PUBLIC KEY</label>
                    <input type="text" value="${state.config.emailConfig.publicKey || ''}" onchange="updateConfig('publicKey', this.value)" placeholder="PUBLIC_KEY">
                </div>
            </div>

            <div class="section-box">
                <h3>ADMIN PASSWORD</h3>
                <p class="helper-text" style="margin-bottom: 15px;">UPDATE THE ADMIN PASSWORD. MINIMUM 6 CHARACTERS.</p>
                <form onsubmit="handleChangePassword(event); return false;">
                    <div>
                        <label>CURRENT PASSWORD</label>
                        <input type="password" name="currentPassword" required placeholder="CURRENT PASSWORD">
                    </div>
                    <div>
                        <label>NEW PASSWORD</label>
                        <input type="password" name="newPassword" required placeholder="NEW PASSWORD">
                    </div>
                    <div>
                        <label>CONFIRM NEW PASSWORD</label>
                        <input type="password" name="confirmPassword" required placeholder="CONFIRM NEW PASSWORD">
                    </div>
                    <button type="submit">UPDATE PASSWORD</button>
                </form>
            </div>

            <button onclick="runSecretSanta()">
                📧 RUN SECRET SANTA
            </button>

            <p class="warning-text">
                ⚠️ ONCE YOU CLICK, ASSIGNMENTS WILL BE<br>MADE AND EMAILS SENT IMMEDIATELY.<br>YOU WON'T SEE WHO GOT WHOM!
            </p>
        `;
    }

    updateProgressBar();
    updateCountdown();
}

function escapeHtml(text) {
    if (text === null || text === undefined) return '';
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

window.showView = showView;
window.toggleQuickPicks = toggleQuickPicks;
window.handleSignup = handleSignup;
window.handleAdminLogin = handleAdminLogin;
window.handleChangePassword = handleChangePassword;
window.updateConfig = updateConfig;
window.runSecretSanta = runSecretSanta;
window.clearAllParticipants = clearAllParticipants;
window.scrollToSignup = scrollToSignup;

function setupStaticListeners() {
    const signupButton = document.getElementById('signupButton');
    if (signupButton) {
        signupButton.addEventListener('click', scrollToSignup);
    }
    const adminButton = document.getElementById('adminTab');
    if (adminButton) {
        adminButton.addEventListener('click', () => showView('admin-login'));
    }
}

window.addEventListener('load', () => {
    if (window.initApp) window.initApp();
    setupStaticListeners();
});
