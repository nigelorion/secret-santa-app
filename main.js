import {
    initializeUI,
    showView,
    toggleQuickPicks,
    handleSignup,
    handleAdminLogin,
    handleChangePassword,
    updateConfig,
    runSecretSanta,
    clearAllParticipants,
    scrollToSignup
} from './ui.js';

window.showView = showView;
window.toggleQuickPicks = toggleQuickPicks;
window.handleSignup = handleSignup;
window.handleAdminLogin = handleAdminLogin;
window.handleChangePassword = handleChangePassword;
window.updateConfig = updateConfig;
window.runSecretSanta = runSecretSanta;
window.clearAllParticipants = clearAllParticipants;
window.scrollToSignup = scrollToSignup;

initializeUI().catch(error => {
    console.error('Failed to initialize UI:', error);
});
