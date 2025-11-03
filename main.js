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
    setAssignmentPreviewVisibility,
    scrollToSignup,
    refreshParticipantCount,
    incrementPublicCount,
    decrementPublicCount
} from './ui.js';

// Expose UI handlers for inline HTML listeners.
window.showView = showView;
window.toggleQuickPicks = toggleQuickPicks;
window.handleSignup = handleSignup;
window.handleAdminLogin = handleAdminLogin;
window.handleAdminLogout = handleAdminLogout;
window.updateConfig = updateConfig;
window.runSecretSanta = runSecretSanta;
window.sendPendingAssignments = sendPendingAssignments;
window.clearAllParticipants = clearAllParticipants;
window.setAssignmentPreviewVisibility = setAssignmentPreviewVisibility;
window.scrollToSignup = scrollToSignup;
window.refreshParticipantCount = refreshParticipantCount;
window.incrementPublicCount = incrementPublicCount;
window.decrementPublicCount = decrementPublicCount;

// Boot the app once the bundle loads.
initializeUI().catch(error => {
    console.error('Failed to initialize UI:', error);
});
