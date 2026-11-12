import { validateSizeSelection } from '../src/lib/size-utils';
import { translate, validLocale } from '../src/modules/preferences/i18n';
import { zhCN } from '../src/modules/preferences/zh-CN';
import assert from 'node:assert/strict';
import { test } from 'node:test';

test('locale fallback and translated interpolation preserve unrecognized content', () => {
    assert.equal(validLocale('zh-CN'), 'zh-CN');
    assert.equal(validLocale('fr'), 'en');
    assert.equal(translate('en', 'Select image {v0}', { v0: 3 }), 'Select image 3');
    assert.equal(translate('zh-CN', 'Select image {v0}', { v0: 3 }), '选择图片 3');
    assert.equal(translate('zh-CN', 'Invalid username or code.'), '用户名或验证码无效。');
    assert.equal(
        translate('zh-CN', 'Cannot paste: Maximum of 16 images reached.'),
        '无法粘贴：已达到 16 张图片的上限。'
    );
    for (const message of [
        'Provider error: unknown upstream detail',
        'gpt-image-2.6-flare',
        'A personal prompt {raw}',
        'constructor',
        '__proto__',
        '{toString}'
    ])
        assert.equal(translate('zh-CN', message), message);
    const invalid = validateSizeSelection('custom', 17, 1024, 'png', 9, 1);
    assert.equal(invalid.valid, false);
    if (!invalid.valid) assert.equal(translate('zh-CN', invalid.reason), '两条边长都必须是 16 的倍数。');
    assert.equal(
        translate('zh-CN', '9 frames are tiled into a 48×48 sheet: Total pixels must be at least 655,360.'),
        '9 帧将平铺为 48×48 的图集：总像素数至少为 655,360。'
    );
    assert.equal(
        translate('zh-CN', "Replace low's authenticator and revoke all their sessions?"),
        '替换 low 的身份验证器并撤销其全部会话吗？'
    );
});

test('Chinese catalog preserves every interpolation parameter', () => {
    const placeholders = (text: string) => [...text.matchAll(/\{\w+\}/g)].map((match) => match[0]).sort();
    for (const [english, chinese] of Object.entries(zhCN)) {
        assert.ok(chinese.trim(), english);
        assert.deepEqual(placeholders(chinese), placeholders(english), english);
    }
});
