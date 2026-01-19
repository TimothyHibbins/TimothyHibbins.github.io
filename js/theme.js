/**
 * Theme Toggle System
 * Manages light/dark mode switching with localStorage persistence
 * Inspired by gwern.net's dark mode implementation
 */

const ThemeManager = {
    // Configuration
    storageKey: 'theme-preference',
    darkModeClass: 'dark-mode',

    // Initialize theme on page load
    init() {
        // Check user preference from localStorage or system preference
        const savedTheme = localStorage.getItem(this.storageKey);
        const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;

        // Set initial theme
        if (savedTheme) {
            this.setTheme(savedTheme);
        } else if (prefersDark) {
            this.setTheme('dark');
        } else {
            this.setTheme('light');
        }

        // Attach event listener to toggle button
        const toggleBtn = document.getElementById('theme-toggle');
        if (toggleBtn) {
            toggleBtn.addEventListener('click', () => this.toggle());
        }

        // Listen for system theme changes
        window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
            if (!localStorage.getItem(this.storageKey)) {
                this.setTheme(e.matches ? 'dark' : 'light');
            }
        });
    },

    // Set theme to 'light' or 'dark'
    setTheme(theme) {
        const isDark = theme === 'dark';
        const html = document.documentElement;
        const body = document.body;

        if (isDark) {
            body.classList.add(this.darkModeClass);
            html.style.colorScheme = 'dark';
        } else {
            body.classList.remove(this.darkModeClass);
            html.style.colorScheme = 'light';
        }

        // Save preference
        localStorage.setItem(this.storageKey, theme);

        // Dispatch custom event
        window.dispatchEvent(new CustomEvent('themechange', { detail: { theme } }));
    },

    // Toggle between light and dark mode
    toggle() {
        const currentTheme = document.body.classList.contains(this.darkModeClass) ? 'dark' : 'light';
        const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
        this.setTheme(newTheme);
    },

    // Get current theme
    getCurrentTheme() {
        return document.body.classList.contains(this.darkModeClass) ? 'dark' : 'light';
    }
};

// Initialize when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => ThemeManager.init());
} else {
    ThemeManager.init();
}
