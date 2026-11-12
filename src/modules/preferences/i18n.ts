import { zhCN } from './zh-CN';

export type Locale = 'en' | 'zh-CN';
export const LOCALE_STORAGE_KEY = 'playground-locale';
export function validLocale(value: unknown): Locale {
    return value === 'zh-CN' ? value : 'en';
}

const patterns = Object.entries(zhCN)
    .filter(([source]) => /\{\w+\}/.test(source))
    .map(([source, target]) => {
        const names: string[] = [];
        const parts = source.split(/(\{\w+\})/g).map((part) => {
            if (/^\{\w+\}$/.test(part)) {
                names.push(part.slice(1, -1));
                return '([\\s\\S]+?)';
            }
            return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        });
        return { expression: new RegExp(`^${parts.join('')}$`), names, target };
    });

/** English source text remains the fallback when upstream adds or changes copy. */
export function translate(locale: Locale, message: string, values: Record<string, string | number> = {}) {
    return translateText(locale, message, values, 0);
}

function translateText(
    locale: Locale,
    message: string,
    values: Record<string, string | number>,
    depth: number
): string {
    let template = locale === 'zh-CN' && Object.hasOwn(zhCN, message) ? zhCN[message] : message;
    // Existing APIs keep their English error contract. Translate only recognized messages at display time.
    if (locale === 'zh-CN' && !Object.hasOwn(zhCN, message)) {
        for (const { expression, names, target } of patterns) {
            const match = expression.exec(message);
            if (!match) continue;
            template = target;
            values = Object.fromEntries(names.map((name, index) => [name, match[index + 1]]));
            if (typeof values.reason === 'string' && depth < 3) {
                values.reason = translateText(locale, values.reason, {}, depth + 1);
            }
            break;
        }
    }
    return template.replace(/\{(\w+)\}/g, (match, key: string) =>
        Object.hasOwn(values, key) ? String(values[key]) : match
    );
}
