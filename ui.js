import { auth, signInWithEmailAndPassword, signOut, onAuthStateChanged } from './firebase.js';
import {
    state,
    TOTAL_PARTICIPANTS_TARGET,
    loadFromFirebase,
    saveParticipant,
    updateConfig as updateConfigState,
    clearAllParticipants as clearAllParticipantsData,
    parseHistoricalPairings,
    setAdminAuth,
    fetchParticipantCount,
    persistParticipantCount
} from './state.js';

// ===== Secret Santa assignment helpers =====

// Tries this many shuffles before declaring the constraints impossible.
const MAX_ASSIGNMENT_ATTEMPTS = 400;
const MIN_SIGNUP_SPIN_MS = 2200;
let isRefreshingCount = false;

function formatQuickPickLink(rawLink) {
    if (!rawLink) return { ok: true, value: '' };
    let candidate = rawLink.trim();
    if (!candidate) return { ok: true, value: '' };
    if (!/^https?:\/\//i.test(candidate)) {
        candidate = `https://${candidate}`;
    }
    try {
        const url = new URL(candidate);
        return { ok: true, value: url.toString() };
    } catch (error) {
        return { ok: false, value: rawLink };
    }
}

// Normalizes participant names so comparisons are case-insensitive.
function normalizeName(name) {
    return (name || '').toString().trim().toLowerCase();
}

// Fisher–Yates shuffle used to randomize giver ordering.
function shuffleInPlace(list) {
    for (let i = list.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [list[i], list[j]] = [list[j], list[i]];
    }
    return list;
}

// Builds a lookup of prior-year matches to avoid repeats.
function buildHistoricalMap(historicalPairs) {
    const map = new Map();
    historicalPairs.forEach(pair => {
        const giverKey = normalizeName(pair.giver);
        const receiverKey = normalizeName(pair.receiver);
        if (!giverKey || !receiverKey) return;
        if (!map.has(giverKey)) {
            map.set(giverKey, new Set());
        }
        map.get(giverKey).add(receiverKey);
    });
    return map;
}

// Creates lightweight participant entries with precomputed values.
function buildParticipantContext(participants) {
    return participants
        .map(raw => ({
            raw,
            lowerName: normalizeName(raw.name),
            spouseLower: normalizeName(raw.spouseName)
        }))
        .filter(entry => !!entry.lowerName);
}

// Prepares the disallowed receivers for each giver (self, spouse, recent draws).
function buildDisallowedMap(context, historicalMap) {
    const disallowedMap = new Map();
    context.forEach(({ lowerName, spouseLower }) => {
        const disallowed = new Set([lowerName]);
        if (spouseLower) disallowed.add(spouseLower);
        const historical = historicalMap.get(lowerName);
        if (historical) {
            historical.forEach(name => disallowed.add(name));
        }
        disallowedMap.set(lowerName, disallowed);
    });
    return disallowedMap;
}

// Attempts a single backtracking pass to produce valid assignments.
function attemptAssignmentBuild(context, disallowedMap) {
    const optionsByGiver = new Map();
    context.forEach(giver => {
        const disallowed = disallowedMap.get(giver.lowerName) || new Set();
        const allowed = context.filter(receiver => !disallowed.has(receiver.lowerName));
        optionsByGiver.set(giver.lowerName, allowed);
    });

    const hasImpossibleGiver = [...optionsByGiver.values()].some(options => options.length === 0);
    if (hasImpossibleGiver) {
        return null;
    }

    const giverOrder = [...context];
    shuffleInPlace(giverOrder);
    giverOrder.sort((a, b) => {
        const aOptions = optionsByGiver.get(a.lowerName)?.length ?? 0;
        const bOptions = optionsByGiver.get(b.lowerName)?.length ?? 0;
        if (aOptions === bOptions) {
            return Math.random() - 0.5;
        }
        return aOptions - bOptions;
    });

    const usedReceivers = new Set();
    const currentAssignments = new Map();
    const proposed = [];

    function backtrack(index) {
        if (index === giverOrder.length) {
            return true;
        }

        const giver = giverOrder[index];
        const baseOptions = optionsByGiver.get(giver.lowerName) || [];
        const choices = baseOptions.filter(receiver => {
            if (usedReceivers.has(receiver.lowerName)) return false;
            if (currentAssignments.get(receiver.lowerName) === giver.lowerName) return false;
            return true;
        });

        if (choices.length === 0) {
            return false;
        }

        shuffleInPlace(choices);

        for (const receiver of choices) {
            usedReceivers.add(receiver.lowerName);
            currentAssignments.set(giver.lowerName, receiver.lowerName);
            proposed.push({ giver, receiver });

            if (backtrack(index + 1)) {
                return true;
            }

            proposed.pop();
            currentAssignments.delete(giver.lowerName);
            usedReceivers.delete(receiver.lowerName);
        }

        return false;
    }

    if (!backtrack(0)) {
        return null;
    }

    return proposed.map(pair => ({
        giver: pair.giver.raw,
        receiver: pair.receiver.raw
    }));
}

// Repeats the backtracking attempt until a valid arrangement is found or we give up.
function generateAssignments(context, disallowedMap) {
    for (let attempt = 0; attempt < MAX_ASSIGNMENT_ATTEMPTS; attempt++) {
        const proposed = attemptAssignmentBuild(context, disallowedMap);
        if (proposed) {
            return proposed;
        }
    }
    return null;
}

function formatWishlistForEmail(wishlist) {
    const trimmed = (wishlist || '').trim();
    if (!trimmed) {
        return {
            text: 'No wish list provided yet',
            html: '<em>No wish list provided yet</em>'
        };
    }

    const text = trimmed.replace(/\r?\n\r?\n/g, '\n\n');
    const html = escapeHtml(trimmed)
        .replace(/\r?\n\r?\n/g, '<br><br>')
        .replace(/\r?\n/g, '<br>');

    return { text, html };
}

// Converts the quick picks to both plain text and HTML bullet list.
function buildQuickPickFormats(quickPicks = []) {
    const trimmed = (quickPicks || [])
        .filter(item => item && (item.title || item.link))
        .slice(0, 3);
    if (trimmed.length === 0) {
        return {
            text: 'Surprise them—no quick picks added!',
            html: '<em>Surprise them—no quick picks added!</em>'
        };
    }

    const text = trimmed.map((item, index) => {
        const title = item.title || `Pick ${index + 1}`;
        const link = item.link ? ` — ${item.link}` : '';
        return `• ${title}${link}`;
    }).join('\n');

    const htmlItems = trimmed.map((item, index) => {
        const title = escapeHtml(item.title || `Pick ${index + 1}`);
        const link = (item.link || '').trim();
        if (link) {
            const encodedLink = escapeHtml(link);
            return `<li><a href="${encodedLink}" target="_blank" rel="noopener">${title}</a></li>`;
        }
        return `<li>${title}</li>`;
    }).join('');

    return {
        text: text || 'Surprise them—no quick picks added!',
        html: `<ul>${htmlItems}</ul>`
    };
}

// ===== General UI helpers =====

// Keeps focused fields visible on small screens when the keyboard opens.
function handleFocusScroll(event) {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    if (!['INPUT', 'TEXTAREA'].includes(target.tagName)) return;
    if (window.innerWidth > 900) return;
    setTimeout(() => {
        target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }, 120);
}

// Adds a temporary snow-fall celebration after a successful signup.
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

// Returns days remaining until Christmas (or 0 if it's here).
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

// Wraps message text with a class for consistent styling.
function showMessage(message, type) {
    const typeClass = type === 'success' ? 'success' : type === 'error' ? 'error' : 'info';
    return `<div class="message ${typeClass}">${message}</div>`;
}

// Places a message above the form and ensures mobile users see it.
function setSignupMessage(message, type = 'info', options = {}) {
    state.signupMessage = {
        text: message || '',
        type: message ? type : 'info'
    };
    const container = document.getElementById('signupMessage');
    if (container) {
        container.innerHTML = message ? showMessage(message, type) : '';
        const focusSelector = options.focusSelector;
        if (focusSelector) {
            const context = options.formElement instanceof HTMLElement ? options.formElement : document;
            const target = context.querySelector(focusSelector);
            if (target && typeof target.focus === 'function') {
                setTimeout(() => target.focus({ preventScroll: true }), 50);
            }
        }
        if (options.scroll !== false && message) {
            requestAnimationFrame(() => {
                container.scrollIntoView({ behavior: 'smooth', block: 'center' });
            });
        }
    }
}

// Updates progress meters and labels on both the public and admin views.
function updateProgressBar() {
    const total = TOTAL_PARTICIPANTS_TARGET || 1;
    const countKnown = state.participantCountKnown && typeof state.participantCount === 'number';
    const signed = countKnown ? state.participantCount : state.participants.length;
    const percentBase = total ? Math.min(signed, total) : signed;
    const percent = Math.min(100, total ? (percentBase / total) * 100 : 100);
    const remaining = Math.max(0, total - signed);
    const signedLabel = countKnown ? `${signed}/${total}` : `?/${total}`;
    const primaryLabel = countKnown
        ? (remaining > 0
            ? `${signedLabel} signed up • ${remaining} to go`
            : `${signedLabel} signed up • Everyone's in!`)
        : `${signedLabel} signed up • Ask the organizer for the latest count`;

    const fill = document.getElementById('progressFill');
    const label = document.getElementById('progressLabel');
    const text = document.getElementById('progressText');
    if (fill) fill.style.width = `${percent}%`;
    if (label) label.textContent = primaryLabel;
    if (text) {
        text.textContent = countKnown
            ? `${signed} of ${total} have already shared their wish lists`
            : `Progress is hidden right now — reach out to the organizer for an update`;
    }

    const adminFill = document.getElementById('adminProgressFill');
    const adminLabel = document.getElementById('adminProgressLabel');
    const adminText = document.getElementById('adminProgressText');
    if (adminFill) adminFill.style.width = `${percent}%`;
    if (adminLabel) {
        const adminTextContent = remaining > 0
            ? `${signedLabel} signed up (${remaining} left)`
            : `${signedLabel} signed up (All set)`;
        adminLabel.textContent = adminTextContent;
    }
    if (adminText) {
        adminText.textContent = countKnown
            ? `${signed} of ${total} have submitted their wish lists`
            : `Progress unavailable until you fetch it as admin`;
    }
}

// Refreshes the countdown copy everywhere it appears.
function updateCountdown() {
    const days = getDaysUntilChristmas();
    let message = '🎄 Christmas is here!';
    if (days > 1) {
        message = `🎅 ${days} days until Christmas!!!`;
    } else if (days === 1) {
        message = '🎅 1 day until Christmas';
    } else if (days === 0) {
        message = '🎄 It\'s Christmas Day!';
    }

    const countdownBox = document.getElementById('countdownBox');
    if (countdownBox) countdownBox.textContent = message;

    const ribbonCountdown = document.getElementById('ribbonCountdown');
    if (ribbonCountdown) ribbonCountdown.textContent = message;

    const adminCountdown = document.getElementById('adminCountdown');
    if (adminCountdown) adminCountdown.textContent = message;
}

// Expands/collapses the optional quick-pick inputs and disables them when hidden.
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

// Scrolls the user to the signup form (and focuses the name field) from anywhere.
function scrollToSignup() {
    const navigate = () => {
        const anchor = document.getElementById('signupFormTop');
        if (anchor) {
            anchor.scrollIntoView({ behavior: 'smooth', block: 'start' });
        } else {
            window.scrollTo({ top: 0, behavior: 'smooth' });
        }
        setTimeout(() => {
            const nameField = document.querySelector('form#signupForm input[name="name"]');
            if (nameField) {
                nameField.focus();
            }
        }, 250);
    };

    if (state.view !== 'signup') {
        showView('signup');
        setTimeout(navigate, 150);
    } else {
        navigate();
    }
}

// Switches between the main signup view and admin subviews.
function showView(view) {
    state.view = view;
    const adminTab = document.getElementById('adminTab');
    if (adminTab) {
        adminTab.classList.toggle('admin-entry-active', view === 'admin' || view === 'admin-login');
    }
    render();
}

// ===== Signup flow =====

// Validates the signup form, saves the participant, and gives user feedback.
async function handleSignup(event) {
    event.preventDefault();
    const form = event.target;
    if (state.signupInFlight) return;
    setSignupMessage('', 'info', { scroll: false });
    state.signupInFlight = true;
    const submissionStartedAt = Date.now();
    render();

    const formData = new FormData(form);
    const name = (formData.get('name') || '').trim();
    const email = (formData.get('email') || '').trim();
    const wishlist = (formData.get('wishlist') || '').trim();
    const spouseName = (formData.get('spouseName') || '').trim();
    const quickPick1 = (formData.get('quickPick1') || '').trim();
    const quickPick2 = (formData.get('quickPick2') || '').trim();
    const quickPick3 = (formData.get('quickPick3') || '').trim();
    const quickPick1LinkRaw = (formData.get('quickPick1Link') || '').trim();
    const quickPick2LinkRaw = (formData.get('quickPick2Link') || '').trim();
    const quickPick3LinkRaw = (formData.get('quickPick3Link') || '').trim();
    const emailPattern = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
    state.signupFormDraft = {
        name,
        email,
        wishlist,
        spouseName,
        quickPick1,
        quickPick2,
        quickPick3,
        quickPick1Link: quickPick1LinkRaw,
        quickPick2Link: quickPick2LinkRaw,
        quickPick3Link: quickPick3LinkRaw
    };

    if (typeof navigator !== 'undefined' && navigator && 'onLine' in navigator && !navigator.onLine) {
        setSignupMessage('Looks like you\'re offline. Reconnect to the internet, then try signing up again.', 'error');
        state.signupInFlight = false;
        render();
        return;
    }

    let currentCount = typeof state.participantCount === 'number' ? state.participantCount : null;
    try {
        const fetchedCount = await fetchParticipantCount();
        if (typeof fetchedCount === 'number') {
            currentCount = fetchedCount;
        }
    } catch (error) {
        console.error('Participant count check failed:', error);
    }

    if (typeof currentCount === 'number') {
        state.participantCount = currentCount;
        state.participantCountKnown = true;
        if (currentCount >= TOTAL_PARTICIPANTS_TARGET) {
            setSignupMessage('Sign-ups are full this year. If you need to update your info, contact the organizer.', 'error');
            state.signupInFlight = false;
            render();
            return;
        }
    } else {
        state.participantCount = null;
        state.participantCountKnown = false;
    }

    const requiredMissing = [];
    if (!name) requiredMissing.push('your name');
    if (!email) requiredMissing.push('your email');
    if (!spouseName) requiredMissing.push('your spouse\'s name');

    if (requiredMissing.length) {
        setSignupMessage(`Please fill out ${requiredMissing.join(', ')} before signing up.`, 'error', {
            focusSelector: !name ? 'input[name="name"]' : !email ? 'input[name="email"]' : 'input[name="spouseName"]',
            formElement: form
        });
        state.signupInFlight = false;
        render();
        return;
    }

    if (!emailPattern.test(email)) {
        setSignupMessage('Please enter a complete email address (example: name@example.com).', 'error', {
            focusSelector: 'input[name="email"]',
            formElement: form
        });
        state.signupInFlight = false;
        render();
        return;
    }

    if (/\s/.test(name)) {
        setSignupMessage('First name only, please. We use first names to build the Secret Santa matches.', 'error', {
            focusSelector: 'input[name="name"]',
            formElement: form
        });
        state.signupInFlight = false;
        render();
        return;
    }

    if (state.participants.some(p => p.email?.toLowerCase() === email.toLowerCase() || p.name?.toLowerCase() === name.toLowerCase())) {
        setSignupMessage('Looks like you\'re already on the list this year. Reach out to the organizer if you need to make a change.', 'error', {
            focusSelector: 'input[name="email"]',
            formElement: form
        });
        state.signupInFlight = false;
        render();
        return;
    }

    const quickPickLinks = [
        { label: 'Quick Pick 1 link', raw: quickPick1LinkRaw, selector: 'input[name="quickPick1Link"]' },
        { label: 'Quick Pick 2 link', raw: quickPick2LinkRaw, selector: 'input[name="quickPick2Link"]' },
        { label: 'Quick Pick 3 link', raw: quickPick3LinkRaw, selector: 'input[name="quickPick3Link"]' }
    ];
    const normalizedQuickPickLinks = [];
    for (const entry of quickPickLinks) {
        const formatted = formatQuickPickLink(entry.raw);
        if (!formatted.ok) {
            setSignupMessage(`Please use a full link for ${entry.label} (for example: https://giftideas.com).`, 'error', {
                focusSelector: entry.selector
            });
            state.signupInFlight = false;
            render();
            return;
        }
        normalizedQuickPickLinks.push(formatted.value);
    }

    try {
        await saveParticipant({
            name,
            email,
            wishlist,
            spouseName,
            quickPicks: [
                { title: quickPick1, link: normalizedQuickPickLinks[0] },
                { title: quickPick2, link: normalizedQuickPickLinks[1] },
                { title: quickPick3, link: normalizedQuickPickLinks[2] }
            ].filter(item => item.title || item.link),
            timestamp: Date.now()
        });
    } catch (error) {
        console.error('Signup error (saving participant):', error);
        console.log('Signup error code:', error?.code);
        const permissionDenied = error?.code === 'permission-denied';
        setSignupMessage(
            permissionDenied
                ? 'Sign-ups are paused right now. Reach out to the organizer if you need help getting on the list.'
                : 'We couldn\'t save your info. Check your connection and try again.',
            'error',
            { formElement: form }
        );
        state.signupInFlight = false;
        render();
        return;
    }

    try {
        const elapsed = Date.now() - submissionStartedAt;
        if (elapsed < MIN_SIGNUP_SPIN_MS) {
            await new Promise(resolve => setTimeout(resolve, MIN_SIGNUP_SPIN_MS - elapsed));
        }
        form.reset();
        toggleQuickPicks(false);
        state.signupComplete = true;
        state.lastSignupName = name;
        if (typeof state.participantCount === 'number') {
            state.participantCount += 1;
        } else {
            state.participantCount = (state.participantCount ?? 0) + 1;
        }
        state.participantCountKnown = true;
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
        state.signupInFlight = false;
        render();
        triggerCelebration();
    } catch (uiError) {
        console.error('Signup UI update error:', uiError);
        setSignupMessage('You\'re signed up, but we hit a snag updating the page. Refresh to double-check your info.', 'info');
        state.signupInFlight = false;
        render();
    }
}

async function refreshParticipantCount(options = {}) {
    if (isRefreshingCount && !options.force) return;
    isRefreshingCount = true;
    const wasKnown = state.participantCountKnown && typeof state.participantCount === 'number';
    try {
        const latest = await fetchParticipantCount();
        if (typeof latest === 'number') {
            state.participantCount = latest;
            state.participantCountKnown = true;
        } else {
            state.participantCountKnown = false;
        }
        if (!options.silent || !wasKnown) {
            render();
        }
    } catch (error) {
        console.error('Participant count refresh failed:', error);
        state.participantCountKnown = false;
        if (!options.silent || wasKnown) {
            render();
        }
    } finally {
        isRefreshingCount = false;
    }
}

// ===== Admin authentication =====

// Handles the email/password admin sign-in flow.
async function handleAdminLogin(event) {
    event.preventDefault();
    const form = event.target;
    const email = (form.adminEmail.value || '').trim();
    const password = form.adminPassword.value || '';
    const messageContainer = document.getElementById('adminLoginMessage');

    if (!email || !password) {
        if (messageContainer) {
            messageContainer.innerHTML = showMessage('Please enter your email and password.', 'error');
        }
        return;
    }

    try {
        if (messageContainer) {
            messageContainer.innerHTML = showMessage('Signing in…', 'info');
        }
        await signInWithEmailAndPassword(auth, email, password);
        form.reset();
    } catch (error) {
        console.error('Admin login error:', error);
        if (messageContainer) {
            const message = error.code === 'auth/invalid-credential'
                ? 'Invalid email or password.'
                : 'Unable to sign in. Please try again.';
            messageContainer.innerHTML = showMessage(message, 'error');
        }
    }
}

// Signs the admin out and clears their session state.
async function handleAdminLogout() {
    try {
        await signOut(auth);
    } catch (error) {
        console.error('Logout error:', error);
    }
}

function parseAssignments() {
    return parseHistoricalPairings();
}

// ===== Admin actions (emails, assignments, cleanup) =====

// Sends out EmailJS notifications for a finalized assignment set.
async function sendEmails(assignments) {
    try {
        emailjs.init(state.config.emailConfig.publicKey);

        document.getElementById('adminMessage').innerHTML = showMessage('Sending emails...', 'info');

        let successCount = 0;
        let failCount = 0;
        const daysUntilChristmas = getDaysUntilChristmas();
        const countdownLine = daysUntilChristmas > 1
            ? `${daysUntilChristmas} days until Christmas!!`
            : daysUntilChristmas === 1
                ? '1 day until Christmas'
                : 'Christmas is here!';

        for (const assignment of assignments) {
            try {
                const wishlistFormats = formatWishlistForEmail(assignment.receiver.wishlist);
                const quickPickFormats = buildQuickPickFormats(assignment.receiver.quickPicks);

                await emailjs.send(
                    state.config.emailConfig.serviceId,
                    state.config.emailConfig.templateId,
                    {
                        to_name: assignment.giver.name,
                        to_email: assignment.giver.email,
                        receiver_name: assignment.receiver.name,
                        receiver_wishlist: wishlistFormats.text,
                        receiver_wishlist_text: wishlistFormats.text,
                        receiver_wishlist_html: wishlistFormats.html,
                        receiver_quick_picks: quickPickFormats.text,
                        receiver_quick_picks_text: quickPickFormats.text,
                        receiver_quick_picks_html: quickPickFormats.html,
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

// Generates a spoiler-free assignment preview that satisfies all constraints.
async function runSecretSanta() {
    if (!state.isAdminAuthenticated) {
        document.getElementById('adminMessage').innerHTML = showMessage('Admin sign-in required to run assignments.', 'error');
        return;
    }
    if (state.participants.length < 3) {
        document.getElementById('adminMessage').innerHTML = showMessage('Need at least 3 participants!', 'error');
        return;
    }

    const historicalPairs = parseAssignments();
    const participantContext = buildParticipantContext(state.participants);

    if (participantContext.length !== state.participants.length) {
        document.getElementById('adminMessage').innerHTML = showMessage('All participants need a name before assignments can be created.', 'error');
        return;
    }

    const historicalMap = buildHistoricalMap(historicalPairs);
    const disallowedMap = buildDisallowedMap(participantContext, historicalMap);
    const assignments = generateAssignments(participantContext, disallowedMap);

    if (!assignments) {
        document.getElementById('adminMessage').innerHTML = showMessage('Could not create valid assignments with current constraints. Try again!', 'error');
        state.pendingAssignments = null;
        state.previewAssignmentsVisible = false;
        render();
        return;
    }

    state.pendingAssignments = assignments;
    state.previewAssignmentsVisible = false;

    console.table(assignments.map(pair => ({
        Giver: pair.giver.name,
        'Giver Email': pair.giver.email,
        Receiver: pair.receiver.name
    })));

    render();

    const adminMessage = document.getElementById('adminMessage');
    if (adminMessage) {
        const emailConfigReady = state.config.emailConfig.serviceId && state.config.emailConfig.templateId && state.config.emailConfig.publicKey;
        const hint = emailConfigReady
            ? 'Click "Reveal matches" if you want to double-check, or go straight to "Send Emails" when you\'re ready.'
            : 'Preview ready. Enter your EmailJS settings before sending.';
        adminMessage.innerHTML = showMessage(`Assignments generated! ${hint}`, emailConfigReady ? 'info' : 'error');
    }
}

// Triggers the actual EmailJS send after the admin reviews the preview.
async function sendPendingAssignments() {
    if (!state.isAdminAuthenticated) {
        document.getElementById('adminMessage').innerHTML = showMessage('Admin sign-in required to send assignments.', 'error');
        return;
    }

    if (!state.pendingAssignments || state.pendingAssignments.length === 0) {
        document.getElementById('adminMessage').innerHTML = showMessage('Generate a preview first, then click SEND EMAILS.', 'info');
        return;
    }

    if (!state.config.emailConfig.serviceId || !state.config.emailConfig.templateId || !state.config.emailConfig.publicKey) {
        document.getElementById('adminMessage').innerHTML = showMessage('Please enter your EmailJS settings before sending.', 'error');
        return;
    }

    const shouldSend = window.confirm('Send Secret Santa assignments to everyone now?');
    if (!shouldSend) {
        document.getElementById('adminMessage').innerHTML = showMessage('Emails were not sent. You can click SEND EMAILS whenever you\'re ready.', 'info');
        return;
    }

    await sendEmails(state.pendingAssignments);
    const messageContent = document.getElementById('adminMessage')?.innerHTML || '';
    state.pendingAssignments = null;
    state.previewAssignmentsVisible = false;
    render();
    const messageContainer = document.getElementById('adminMessage');
    if (messageContainer && messageContent) {
        messageContainer.innerHTML = messageContent;
    }
}

// Toggles whether the admin panel reveals or hides the pending matches.
function setAssignmentPreviewVisibility(visible) {
    if (!state.pendingAssignments || state.pendingAssignments.length === 0) {
        return;
    }
    const messageContent = document.getElementById('adminMessage')?.innerHTML || '';
    state.previewAssignmentsVisible = !!visible;
    render();
    const messageContainer = document.getElementById('adminMessage');
    if (messageContainer && messageContent) {
        messageContainer.innerHTML = messageContent;
    }
}

// Removes every signup (handy for testing cycles).
async function clearAllParticipants() {
    if (!state.isAdminAuthenticated) {
        const messageContainer = document.getElementById('adminMessage');
        if (messageContainer) {
            messageContainer.innerHTML = showMessage('Admin sign-in required to clear participants.', 'error');
        }
        return;
    }
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
        await clearAllParticipantsData();
        await loadFromFirebase({ fetchParticipants: true });
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

async function modifyPublicCount(delta) {
    if (!state.isAdminAuthenticated) {
        const messageContainer = document.getElementById('adminMessage');
        if (messageContainer) {
            messageContainer.innerHTML = showMessage('Sign in as admin to update the public counter.', 'error');
        }
        return;
    }

    const messageContainer = document.getElementById('adminMessage');

    try {
        if (messageContainer) {
            const verb = delta >= 0 ? 'Incrementing' : 'Decrementing';
            messageContainer.innerHTML = showMessage(`${verb} public counter…`, 'info');
        }

        let baseline = state.participantCount;
        if (typeof baseline !== 'number') {
            try {
                const remoteCount = await fetchParticipantCount();
                if (typeof remoteCount === 'number') {
                    baseline = remoteCount;
                }
            } catch (error) {
                console.error('Unable to load current public counter:', error);
            }
        }

        const current = typeof baseline === 'number' ? baseline : 0;
        if (delta < 0 && current === 0) {
            if (messageContainer) {
                messageContainer.innerHTML = showMessage('Public counter is already at zero.', 'info');
            }
            return;
        }

        const nextCount = Math.max(0, current + delta);
        await persistParticipantCount(nextCount);

        render();

        if (messageContainer) {
            const action = delta >= 0 ? 'Incremented' : 'Decremented';
            messageContainer.innerHTML = showMessage(`${action} public counter to ${nextCount}.`, 'success');
        }
    } catch (error) {
        console.error('Error adjusting participant count:', error);
        if (messageContainer) {
            messageContainer.innerHTML = showMessage('Could not update the public counter. Try again in a moment.', 'error');
        }
    }
}

async function incrementPublicCount() {
    await modifyPublicCount(1);
}

async function decrementPublicCount() {
    await modifyPublicCount(-1);
}

// Persists config edits but only when the admin is signed in.
function updateConfig(field, value) {
    if (!state.isAdminAuthenticated) {
        const messageContainer = document.getElementById('adminMessage');
        if (messageContainer) {
            messageContainer.innerHTML = showMessage('Sign in as admin to update settings.', 'error');
        }
        return Promise.resolve(false);
    }
    return updateConfigState(field, value);
}

// ===== Rendering and bootstrapping =====

// Draws whichever view (signup/admin) matches the current state.
function render() {
    const content = document.getElementById('content');
    if (!content) return;
    const progressAnchor = document.getElementById('progressAnchor');

    if (state.view === 'signup') {
        const messageHtml = `<div id="signupMessage" class="message-container" aria-live="polite" aria-atomic="true">${state.signupMessage.text ? showMessage(state.signupMessage.text, state.signupMessage.type) : ''}</div>`;

        if (progressAnchor) {
            progressAnchor.innerHTML = `
                <div class="progress-wrap">
                    <div class="progress-grid">
                        <div class="progress-bar" id="progressBar">
                            <div class="progress-fill" id="progressFill" style="width:0%"></div>
                            <span id="progressLabel"></span>
                        </div>
                        <p class="progress-text" id="progressText"></p>
                    </div>
                </div>
            `;
        }

        let shellClass = 'signup-shell card';
        let shellContent = '';
        if (state.signupInFlight) {
            shellClass += ' is-loading';
            shellContent = `
                <div class="signup-loading">
                    <div class="loading-ornament">
                        <span class="loader-ring"></span>
                        <span class="loader-bauble">🎄</span>
                    </div>
                    <div class="loading-lights">
                        <span>✨</span><span>🎁</span><span>❄️</span><span>🕯️</span>
                    </div>
                    <p class="success-lead loading-headline">Packing your wish list for the sleigh…</p>
                    <p class="helper-text success-subtext loading-subtext">Snowflakes swirling, elves matching—give us a sec!</p>
                </div>
            `;
        } else if (state.signupComplete) {
            shellClass += ' is-complete sparkle-in';
            const celebrant = escapeHtml(state.lastSignupName || 'Secret Santa friend');
            shellContent = `
                <div class="signup-success">
                    <div class="success-badge">🎄</div>
                    <h2>YOU'RE ON THE NICE LIST!</h2>
                    <p class="success-lead">Thanks, ${celebrant}! Your wish list is tucked safely into Santa's machine.</p>
                    <p class="helper-text success-subtext">We’ll email you once the match-up goes out. Sit tight, sip some cocoa, and get ready to play Santa.</p>
                    <div class="success-confetti">🎁 ❄️ 🎄 ✨</div>
                </div>
            `;
        } else {
            shellClass += ' is-form';
            shellContent = `
                <p class="intro-text">Fill this out once and we’ll take care of the rest—share who you are, what you love, and we’ll handle the match-up magic.</p>
                <form id="signupForm" onsubmit="handleSignup(event); return false;">
                    <div>
                        <label>YOUR FIRST NAME *</label>
                        <input type="text" name="name" placeholder="Santa" autocomplete="given-name" required value="${escapeHtml(state.signupFormDraft.name)}">
                    </div>
                    <div>
                        <label>YOUR EMAIL *</label>
                        <input type="email" name="email" placeholder="santa@email.com" autocomplete="email" required value="${escapeHtml(state.signupFormDraft.email)}">
                    </div>
                    <div>
                        <label>WISH LIST LETTER</label>
                        <textarea name="wishlist" rows="5" placeholder="Say hi to your Santa, share what you're into this season, and mention any themes or surprises you'd love.">${escapeHtml(state.signupFormDraft.wishlist)}</textarea>
                    </div>
                    <button type="button" class="toggle-quick-picks" id="quickPicksToggle" onclick="toggleQuickPicks()">➕ Add quick picks (optional)</button>
                    <div class="section-box quick-picks" id="quickPicksSection">
                        <h3 style="margin-bottom:12px; color:#f5d67b;">QUICK PICKS</h3>
                        <p class="helper-text" style="margin-bottom:10px;">Add up to three specific ideas or product links in case your Santa needs a nudge.</p>
                        <div style="display:grid; gap:12px;">
                            <div style="display:grid; gap:8px;">
                                <label style="margin-bottom:0;">ITEM 1 TITLE</label>
                                <input type="text" name="quickPick1" placeholder="Cozy flannel PJs" disabled value="${escapeHtml(state.signupFormDraft.quickPick1)}">
                                <input type="url" name="quickPick1Link" placeholder="https://flannels.com" disabled value="${escapeHtml(state.signupFormDraft.quickPick1Link)}">
                            </div>
                            <div style="display:grid; gap:8px;">
                                <label style="margin-bottom:0;">ITEM 2 TITLE</label>
                                <input type="text" name="quickPick2" placeholder="Holiday cookbook" disabled value="${escapeHtml(state.signupFormDraft.quickPick2)}">
                                <input type="url" name="quickPick2Link" placeholder="https://cookbooks.com" disabled value="${escapeHtml(state.signupFormDraft.quickPick2Link)}">
                            </div>
                            <div style="display:grid; gap:8px;">
                                <label style="margin-bottom:0;">ITEM 3 TITLE</label>
                                <input type="text" name="quickPick3" placeholder="Local coffee card" disabled value="${escapeHtml(state.signupFormDraft.quickPick3)}">
                                <input type="url" name="quickPick3Link" placeholder="https://coffeeshop.com" disabled value="${escapeHtml(state.signupFormDraft.quickPick3Link)}">
                            </div>
                        </div>
                    </div>
                    <div>
                        <label>SPOUSE NAME *</label>
                        <input type="text" name="spouseName" placeholder="So you aren't matched!" autocomplete="off" required value="${escapeHtml(state.signupFormDraft.spouseName)}">
                    </div>
                    <button type="submit">SIGN ME UP! 🎅</button>
                </form>
            `;
        }

        content.innerHTML = `
            <div id="signupFormTop"></div>
            ${messageHtml}
            <div class="${shellClass}">
                ${shellContent}
            </div>
        `;

        if (!state.signupInFlight && !state.signupComplete) {
            toggleQuickPicks(false);
            if (state.signupMessage.text) {
                const messageNode = document.getElementById('signupMessage');
                if (messageNode) {
                    requestAnimationFrame(() => {
                        messageNode.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    });
                }
            }
        }
    } else if (!state.isAdminAuthenticated) {
        if (progressAnchor) {
            progressAnchor.innerHTML = '';
        }
        state.view = 'admin-login';
        content.innerHTML = `
            <h2>ADMIN LOGIN</h2>
            <div id="adminLoginMessage"></div>
            <form onsubmit="handleAdminLogin(event); return false;">
                <p class="helper-text" style="margin-bottom: 20px;">Sign in with your admin email to continue.</p>
                <input type="email" name="adminEmail" required placeholder="ADMIN EMAIL">
                <input type="password" name="adminPassword" required placeholder="PASSWORD">
                <button type="submit">
                    LOGIN
                </button>
            </form>
            <button type="button" class="button-secondary" onclick="showView('signup')" style="margin-top:16px;width:auto;padding:10px 18px;">⬅ BACK TO SIGN UP</button>
        `;
    } else {
        if (progressAnchor) {
            progressAnchor.innerHTML = '';
        }
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

        const hasPendingAssignments = Array.isArray(state.pendingAssignments) && state.pendingAssignments.length > 0;
        const previewVisible = state.previewAssignmentsVisible && hasPendingAssignments;

        content.innerHTML = `
            <h2>ADMIN PANEL</h2>
            <div class="countdown-box" id="adminCountdown">Loading countdown...</div>
            <div class="progress-wrap">
                <div class="progress-grid">
                    <div class="progress-bar" id="adminProgressBar">
                        <div class="progress-fill" id="adminProgressFill" style="width:0%"></div>
                        <span id="adminProgressLabel"></span>
                    </div>
                    <p class="progress-text" id="adminProgressText"></p>
                </div>
            </div>
            <p class="helper-text" style="text-align:center;margin-bottom:12px;">Signed in as ${escapeHtml(state.adminEmail)}</p>
            <div style="display:flex; gap:10px; justify-content:center; flex-wrap:wrap; margin-bottom:18px;">
                <button type="button" class="button-secondary" onclick="handleAdminLogout()" style="width:auto;padding:10px 18px;">SIGN OUT</button>
                <button type="button" class="button-secondary" onclick="showView('signup')" style="width:auto;padding:10px 18px;">⬅ BACK TO SIGN UP</button>
            </div>
            <div id="adminMessage"></div>

            <div style="margin-bottom: 30px;">
                <h3>PARTICIPANTS (${state.participants.length})</h3>
                ${participantsList}
                <div style="display:flex; flex-wrap:wrap; gap:10px; margin-top:12px;">
                    <button type="button" class="button-secondary" onclick="clearAllParticipants()">🧹 CLEAR ALL SIGNUPS</button>
                    <button type="button" class="button-secondary" onclick="decrementPublicCount()">➖ DECREMENT COUNTER</button>
                    <button type="button" class="button-secondary" onclick="incrementPublicCount()">➕ INCREMENT COUNTER</button>
                </div>
                <p class="helper-text" style="margin-top:8px;">🧹 Clear removes every signup so you can start fresh during testing.</p>
                <p class="helper-text">➖/➕ Adjust the public counter without exposing private signup data.</p>
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

            <div class="section-box green">
                <h3>SECRET SANTA DRAW</h3>
                <p class="helper-text" style="margin-bottom: 15px;">STEP 1: GENERATE A PREVIEW • STEP 2: SEND EMAILS</p>
                <div style="display:flex; flex-wrap:wrap; gap:10px; justify-content:center; margin-bottom:12px;">
                    <button type="button" class="button-primary" onclick="runSecretSanta()">🎲 GENERATE PREVIEW</button>
                    <button type="button" class="button-secondary" onclick="sendPendingAssignments()" ${hasPendingAssignments ? '' : 'disabled'}>📧 SEND EMAILS</button>
                </div>
                ${hasPendingAssignments ? `
                    <div class="preview-box">
                        <p class="helper-text" style="margin-bottom:10px;">
                            ${previewVisible
                                ? 'Preview ready! Emails won\'t send until you click SEND EMAILS.'
                                : 'Preview ready! Matches stay hidden so you don\'t spoil the surprise. They\'re also logged in the console.'}
                        </p>
                        ${previewVisible
                            ? `
                                <ul class="preview-list">
                                    ${state.pendingAssignments.map(pair => `<li>${escapeHtml(pair.giver.name)} → ${escapeHtml(pair.receiver.name)}</li>`).join('')}
                                </ul>
                            `
                            : `
                                <p class="preview-hidden">Matches are hidden. Click "Reveal matches" if you need to peek.</p>
                            `}
                        <div class="preview-actions">
                            ${previewVisible
                                ? `<button type="button" class="button-secondary" onclick="setAssignmentPreviewVisibility(false)">🙈 Hide matches</button>`
                                : `<button type="button" class="button-secondary" onclick="setAssignmentPreviewVisibility(true)">👀 Reveal matches</button>`}
                        </div>
                    </div>
                ` : `
                    <p class="helper-text" style="text-align:center;">Click GENERATE PREVIEW to see this year's matches before emailing.</p>
                `}
            </div>
        `;
    }

    updateProgressBar();
        updateCountdown();
}

// Escapes user-provided values before injecting into HTML.
function escapeHtml(text) {
    if (text === null || text === undefined) return '';
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// Sets up persistent listeners for the static buttons present on every view.
function setupStaticListeners() {
    const signupButton = document.getElementById('signupButton');
    if (signupButton) {
        signupButton.addEventListener('click', scrollToSignup);
    }
    const adminButton = document.getElementById('adminTab');
    if (adminButton) {
        adminButton.addEventListener('click', () => showView(state.isAdminAuthenticated ? 'admin' : 'admin-login'));
    }
}

// Loads initial data, wires up auth listeners, and kicks off the first render.
async function initializeUI() {
    document.addEventListener('focusin', handleFocusScroll);
    setupStaticListeners();

    updateCountdown();
    await loadFromFirebase({ fetchParticipants: false });
    render();
    refreshParticipantCount({ silent: true }).catch(() => {});

    onAuthStateChanged(auth, async (user) => {
        try {
            let claims = {};
            if (user) {
                const tokenResult = await user.getIdTokenResult(true);
                claims = tokenResult.claims;
            }
            setAdminAuth(user, claims);

            if (state.isAdminAuthenticated) {
                await loadFromFirebase({ fetchParticipants: true });
                await refreshParticipantCount({ force: true, silent: true });
            } else {
                state.participants = [];
            }

            if (state.isAdminAuthenticated && state.view === 'admin-login') {
                state.view = 'admin';
            }
            if (!state.isAdminAuthenticated && state.view === 'admin') {
                state.view = 'admin-login';
            }
            render();
        } catch (error) {
            console.error('Auth state error:', error);
        }
    });
}

export {
    initializeUI,
    showView,
    toggleQuickPicks,
    handleSignup,
    handleAdminLogin,
    handleAdminLogout,
    updateConfig,
    runSecretSanta,
    sendPendingAssignments,
    setAssignmentPreviewVisibility,
    clearAllParticipants,
    incrementPublicCount,
    decrementPublicCount,
    scrollToSignup,
    refreshParticipantCount
};
