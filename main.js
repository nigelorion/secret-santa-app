import {
    initializeUI,
    showView,
    toggleQuickPicks,
    handleSignup,
    handleAdminLogin,
    handleAdminLogout,
    updateConfig,
    runSecretSanta,
    sendPendingAssignments,
    clearAllParticipants,
    scrollToSignup
} from './ui.js';

window.showView = showView;
window.toggleQuickPicks = toggleQuickPicks;
window.handleSignup = handleSignup;
window.handleAdminLogin = handleAdminLogin;
window.handleAdminLogout = handleAdminLogout;
window.updateConfig = updateConfig;
window.runSecretSanta = runSecretSanta;
window.sendPendingAssignments = sendPendingAssignments;
window.clearAllParticipants = clearAllParticipants;
window.scrollToSignup = scrollToSignup;

initializeUI().catch(error => {
    console.error('Failed to initialize UI:', error);
});
