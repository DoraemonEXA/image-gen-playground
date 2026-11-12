'use client';

import { type Locale, LOCALE_STORAGE_KEY, translate, validLocale } from './i18n';
import { useTheme } from 'next-themes';
import * as React from 'react';

type Preferences = {
    locale: Locale;
    setLocale: (locale: Locale) => void;
    t: (message: string, values?: Record<string, string | number>) => string;
};
const Context = React.createContext<Preferences>({ locale: 'en', setLocale: () => {}, t: (message) => message });
export const usePreferences = () => React.useContext(Context);

export function PreferencesProvider({ children }: { children: React.ReactNode }) {
    const [locale, updateLocale] = React.useState<Locale>('en');
    React.useEffect(() => {
        let active = true;
        queueMicrotask(() => {
            if (!active) return;
            try {
                updateLocale(validLocale(localStorage.getItem(LOCALE_STORAGE_KEY)));
            } catch {
                /* Browser storage is optional. */
            }
        });
        const sync = (event: StorageEvent) => {
            if (event.key === LOCALE_STORAGE_KEY || event.key === null) updateLocale(validLocale(event.newValue));
        };
        window.addEventListener('storage', sync);
        return () => {
            active = false;
            window.removeEventListener('storage', sync);
        };
    }, []);
    React.useEffect(() => {
        document.documentElement.lang = locale;
    }, [locale]);
    const setLocale = React.useCallback((next: Locale) => {
        updateLocale(next);
        try {
            localStorage.setItem(LOCALE_STORAGE_KEY, next);
        } catch {
            /* Keep the in-memory preference. */
        }
    }, []);
    const t = React.useCallback(
        (message: string, values?: Record<string, string | number>) => translate(locale, message, values),
        [locale]
    );
    const value = React.useMemo(() => ({ locale, setLocale, t }), [locale, setLocale, t]);
    return (
        <Context.Provider value={value}>
            <PreferenceControls />
            {children}
        </Context.Provider>
    );
}

const subscribeMounted = () => () => {};
function PreferenceControls() {
    const { locale, setLocale, t } = usePreferences();
    const { theme, setTheme } = useTheme();
    const mounted = React.useSyncExternalStore(
        subscribeMounted,
        () => true,
        () => false
    );
    const select =
        'rounded-md border border-border bg-background px-2 py-1 text-foreground focus-visible:outline-2 focus-visible:outline-ring';
    return (
        <nav
            aria-label={t('Display preferences')}
            className='border-border bg-background text-foreground flex flex-wrap justify-end gap-4 border-b px-4 py-2 text-sm'>
            <div className='flex items-center gap-2'>
                <label htmlFor='display-language'>{t('Language')}</label>
                <select
                    id='display-language'
                    className={select}
                    value={locale}
                    onChange={(event) => setLocale(validLocale(event.target.value))}>
                    <option value='en'>English</option>
                    <option value='zh-CN'>简体中文</option>
                </select>
            </div>
            <div className='flex items-center gap-2'>
                <label htmlFor='display-theme'>{t('Theme')}</label>
                <select
                    id='display-theme'
                    className={select}
                    value={mounted ? theme : 'system'}
                    disabled={!mounted}
                    onChange={(event) => setTheme(event.target.value)}>
                    <option value='system'>{t('System')}</option>
                    <option value='light'>{t('Light')}</option>
                    <option value='dark'>{t('Dark')}</option>
                </select>
            </div>
        </nav>
    );
}
