'use client';

import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Slider } from '@/components/ui/slider';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
    EXTENDED_QUALITIES,
    getAvailableOutputFormats,
    GIF_FRAME_COUNT,
    GIF_FRAME_DURATION_MS,
    type GptImageModel,
    type ImageBackground,
    type ImageComplexity,
    type ImageMode,
    type ImageModeration,
    type ImageOutputFormat,
    type ImageQuality,
    MODEL_CAPABILITIES,
    SVG_WRITER_MODELS,
    type SvgReasoningEffort,
    type SvgWriterModel
} from '@/lib/models';
import {
    CUSTOM_SIZE_EDGE_MULTIPLE,
    CUSTOM_SIZE_MAX_ASPECT,
    CUSTOM_SIZE_MAX_EDGE,
    CUSTOM_SIZE_MAX_PIXELS,
    CUSTOM_SIZE_MIN_PIXELS,
    getGifSheetGrids,
    getPresetTooltip,
    GIF_MAX_REQUEST_PIXELS,
    type SizePreset,
    type SizeValidation
} from '@/lib/size-utils';
import { usePreferences } from '@/modules/preferences/client';
import {
    Brain,
    BrickWall,
    Eraser,
    FileImage,
    Film,
    PenTool,
    RectangleHorizontal,
    RectangleVertical,
    ShieldAlert,
    ShieldCheck,
    Sparkles,
    Square,
    SquareDashed,
    Tally1,
    Tally2,
    Tally3,
    Tally4,
    Tally5
} from 'lucide-react';
import * as React from 'react';

/** SVG writer settings; only the generate form has them, since edits can't return SVG. */
export type SvgOptions = {
    model: SvgWriterModel;
    setModel: React.Dispatch<React.SetStateAction<SvgWriterModel>>;
    /** `null` leaves the effort to the writer model's default. */
    effort: SvgReasoningEffort | null;
    setEffort: React.Dispatch<React.SetStateAction<SvgReasoningEffort | null>>;
};

type ImageOptionsProps = {
    /** Also prefixes every element id, so the generate and edit forms (both mounted) never share an id. */
    mode: ImageMode;
    model: GptImageModel;
    disabled: boolean;
    size: SizePreset;
    setSize: React.Dispatch<React.SetStateAction<SizePreset>>;
    customWidth: number;
    setCustomWidth: React.Dispatch<React.SetStateAction<number>>;
    customHeight: number;
    setCustomHeight: React.Dispatch<React.SetStateAction<number>>;
    sizeValidation: SizeValidation;
    quality: ImageQuality;
    setQuality: React.Dispatch<React.SetStateAction<ImageQuality>>;
    complexity: ImageComplexity;
    setComplexity: React.Dispatch<React.SetStateAction<ImageComplexity>>;
    background: ImageBackground;
    setBackground: React.Dispatch<React.SetStateAction<ImageBackground>>;
    outputFormat: ImageOutputFormat;
    setOutputFormat: React.Dispatch<React.SetStateAction<ImageOutputFormat>>;
    compression: number[];
    setCompression: React.Dispatch<React.SetStateAction<number[]>>;
    frameCount: number;
    setFrameCount: React.Dispatch<React.SetStateAction<number>>;
    frameDurationMs: number;
    setFrameDurationMs: React.Dispatch<React.SetStateAction<number>>;
    svg?: SvgOptions;
    moderation: ImageModeration;
    setModeration: React.Dispatch<React.SetStateAction<ImageModeration>>;
};

const RadioItemWithIcon = ({
    value,
    id,
    label,
    Icon
}: {
    value: string;
    id: string;
    label: string;
    Icon: React.ElementType;
}) => {
    const { t } = usePreferences();
    return (
        <div className='flex items-center space-x-2'>
            <RadioGroupItem
                value={value}
                id={id}
                className='border-foreground/40 text-foreground data-[state=checked]:border-foreground data-[state=checked]:text-foreground'
            />
            <Label htmlFor={id} className='text-foreground/80 flex cursor-pointer items-center gap-2 text-base'>
                <Icon className='text-foreground/60 h-5 w-5' />
                {t(label)}
            </Label>
        </div>
    );
};

const SIZE_PRESETS: { value: SizePreset; label: string; Icon: React.ElementType }[] = [
    { value: 'square', label: 'Square', Icon: Square },
    { value: 'landscape', label: 'Landscape', Icon: RectangleHorizontal },
    { value: 'portrait', label: 'Portrait', Icon: RectangleVertical }
];

const FORMAT_OPTIONS: Record<ImageOutputFormat, { label: string; Icon: React.ElementType }> = {
    png: { label: 'PNG', Icon: FileImage },
    jpeg: { label: 'JPEG', Icon: FileImage },
    webp: { label: 'WebP', Icon: FileImage },
    gif: { label: 'GIF', Icon: Film },
    svg: { label: 'SVG', Icon: PenTool }
};

export const SLIDER_CLASS =
    'mt-3 [&>button]:border-background [&>button]:bg-foreground [&>button]:ring-offset-background [&>span:first-child]:h-1 [&>span:first-child>span]:bg-foreground';

export function ImageOptions({
    mode,
    model,
    disabled,
    size,
    setSize,
    customWidth,
    setCustomWidth,
    customHeight,
    setCustomHeight,
    sizeValidation,
    quality,
    setQuality,
    complexity,
    setComplexity,
    background,
    setBackground,
    outputFormat,
    setOutputFormat,
    compression,
    setCompression,
    frameCount,
    setFrameCount,
    frameDurationMs,
    setFrameDurationMs,
    svg,
    moderation,
    setModeration
}: ImageOptionsProps) {
    const { t, locale } = usePreferences();
    const id = (suffix: string) => `${mode}-${suffix}`;
    const capabilities = MODEL_CAPABILITIES[model];
    const availableFormats = getAvailableOutputFormats(model, mode);
    const formatAvailable = availableFormats.includes(outputFormat);
    const isGif = outputFormat === 'gif';
    const showCompression = outputFormat === 'jpeg' || outputFormat === 'webp';

    // Reset options the newly selected model rejects.
    React.useEffect(() => {
        if (!capabilities.extendedQuality && EXTENDED_QUALITIES.includes(quality)) {
            setQuality('auto');
        }
    }, [capabilities.extendedQuality, quality, setQuality]);
    React.useEffect(() => {
        if (!formatAvailable) {
            setOutputFormat('png');
        }
    }, [formatAvailable, setOutputFormat]);

    const handleOutputFormatChange = (value: string) => {
        const format = value as ImageOutputFormat;
        setOutputFormat(format);
        // The fixed presets are far larger than any GIF frame can be.
        if (format === 'gif' && size !== 'auto' && size !== 'custom') {
            setSize('auto');
        }
    };

    const loopSeconds = (frameCount * frameDurationMs) / 1000;
    // GIF frames only need the tiled sheet's edges to be multiples of 16, so some finer sizes fit (520px in a
    // 4×4 sheet); the sheet validation reports which.
    const sizeStep = isGif ? CUSTOM_SIZE_EDGE_MULTIPLE / 4 : CUSTOM_SIZE_EDGE_MULTIPLE;

    return (
        <>
            <div className='space-y-3'>
                <Label className='text-foreground block'>{isGif ? t('Frame Size') : t('Size')}</Label>
                <RadioGroup
                    value={size}
                    onValueChange={(value) => setSize(value as SizePreset)}
                    disabled={disabled}
                    className='flex flex-wrap gap-x-5 gap-y-3'>
                    <RadioItemWithIcon value='auto' id={id('size-auto')} label={t('Auto')} Icon={Sparkles} />
                    <RadioItemWithIcon value='custom' id={id('size-custom')} label={t('Custom')} Icon={SquareDashed} />
                    {!isGif &&
                        SIZE_PRESETS.map(({ value, label, Icon }) => (
                            <Tooltip key={value}>
                                <TooltipTrigger asChild>
                                    <div>
                                        <RadioItemWithIcon
                                            value={value}
                                            id={id(`size-${value}`)}
                                            label={t(label)}
                                            Icon={Icon}
                                        />
                                    </div>
                                </TooltipTrigger>
                                <TooltipContent>{getPresetTooltip(value)}</TooltipContent>
                            </Tooltip>
                        ))}
                </RadioGroup>
                {size === 'custom' && (
                    <div className='border-foreground/10 bg-foreground/5 space-y-2 rounded-md border p-3'>
                        <div className='flex items-center gap-3'>
                            <div className='flex-1 space-y-1'>
                                <Label htmlFor={id('custom-width')} className='text-foreground/70 text-xs'>
                                    {t('Width (px)')}
                                </Label>
                                <Input
                                    id={id('custom-width')}
                                    type='number'
                                    min={CUSTOM_SIZE_EDGE_MULTIPLE}
                                    max={CUSTOM_SIZE_MAX_EDGE}
                                    step={sizeStep}
                                    value={customWidth}
                                    onChange={(e) => setCustomWidth(parseInt(e.target.value, 10) || 0)}
                                    disabled={disabled}
                                    className='border-foreground/20 bg-background text-foreground focus:border-foreground/50 focus:ring-foreground/50 rounded-md border'
                                />
                            </div>
                            <span className='text-foreground/60 pt-5'>×</span>
                            <div className='flex-1 space-y-1'>
                                <Label htmlFor={id('custom-height')} className='text-foreground/70 text-xs'>
                                    {t('Height (px)')}
                                </Label>
                                <Input
                                    id={id('custom-height')}
                                    type='number'
                                    min={CUSTOM_SIZE_EDGE_MULTIPLE}
                                    max={CUSTOM_SIZE_MAX_EDGE}
                                    step={sizeStep}
                                    value={customHeight}
                                    onChange={(e) => setCustomHeight(parseInt(e.target.value, 10) || 0)}
                                    disabled={disabled}
                                    className='border-foreground/20 bg-background text-foreground focus:border-foreground/50 focus:ring-foreground/50 rounded-md border'
                                />
                            </div>
                        </div>
                        {isGif ? (
                            <p className='text-foreground/50 text-xs'>
                                {frameCount} {t('frames are rendered tiled into one')}{' '}
                                {getGifSheetGrids(frameCount)
                                    .map(([columns, rows]) => `${columns}×${rows}`)
                                    .join(t(' or '))}{' '}
                                {t(
                                    'sheet. The sheet must meet the limits below, and the number of images × sheet pixels must stay within'
                                )}{' '}
                                {GIF_MAX_REQUEST_PIXELS.toLocaleString(locale)}.
                            </p>
                        ) : (
                            <p className='text-foreground/50 text-xs'>
                                {(customWidth * customHeight).toLocaleString(locale)} {t('pixels (')}
                                {(((customWidth * customHeight) / CUSTOM_SIZE_MAX_PIXELS) * 100).toFixed(1)}
                                {t('% of max) ·')}{' '}
                                {customWidth > 0 && customHeight > 0
                                    ? t('{v0}:1 ratio', {
                                          v0: (
                                              Math.max(customWidth, customHeight) / Math.min(customWidth, customHeight)
                                          ).toFixed(2)
                                      })
                                    : '—'}
                            </p>
                        )}
                        {!sizeValidation.valid && (
                            <p className='text-destructive text-xs'>{t(sizeValidation.reason)}</p>
                        )}
                        <p className='text-foreground/40 text-xs'>
                            {t('Constraints: multiples of')} {CUSTOM_SIZE_EDGE_MULTIPLE}
                            {t(', max edge')} {CUSTOM_SIZE_MAX_EDGE}
                            {t('px, aspect ratio ≤')} {CUSTOM_SIZE_MAX_ASPECT}:1,{' '}
                            {CUSTOM_SIZE_MIN_PIXELS.toLocaleString(locale)} {t('to')}{' '}
                            {CUSTOM_SIZE_MAX_PIXELS.toLocaleString(locale)} {t('total pixels.')}
                        </p>
                    </div>
                )}
            </div>

            <div className='space-y-3'>
                <Label className='text-foreground block'>{t('Quality')}</Label>
                <RadioGroup
                    value={quality}
                    onValueChange={(value) => setQuality(value as ImageQuality)}
                    disabled={disabled}
                    className='flex flex-wrap gap-x-5 gap-y-3'>
                    <RadioItemWithIcon value='auto' id={id('quality-auto')} label={t('Auto')} Icon={Sparkles} />
                    <RadioItemWithIcon value='low' id={id('quality-low')} label={t('Low')} Icon={Tally1} />
                    <RadioItemWithIcon value='medium' id={id('quality-medium')} label={t('Medium')} Icon={Tally2} />
                    <RadioItemWithIcon value='high' id={id('quality-high')} label={t('High')} Icon={Tally3} />
                    {capabilities.extendedQuality && (
                        <>
                            <RadioItemWithIcon
                                value='xhigh'
                                id={id('quality-xhigh')}
                                label={t('XHigh')}
                                Icon={Tally4}
                            />
                            <RadioItemWithIcon value='max' id={id('quality-max')} label={t('Max')} Icon={Tally5} />
                        </>
                    )}
                </RadioGroup>
            </div>

            {capabilities.complexity && (
                <div className='space-y-3'>
                    <Label className='text-foreground block'>{t('Complexity')}</Label>
                    <RadioGroup
                        value={complexity}
                        onValueChange={(value) => setComplexity(value as ImageComplexity)}
                        disabled={disabled}
                        className='flex flex-wrap gap-x-5 gap-y-3'>
                        <RadioItemWithIcon value='low' id={id('complexity-low')} label={t('Low')} Icon={Tally1} />
                        <RadioItemWithIcon
                            value='medium'
                            id={id('complexity-medium')}
                            label={t('Medium')}
                            Icon={Tally2}
                        />
                        <RadioItemWithIcon value='high' id={id('complexity-high')} label={t('High')} Icon={Tally3} />
                    </RadioGroup>
                    <p className='text-foreground/40 text-xs'>
                        {t(
                            'How much the model plans before rendering. Lower suits focused edits; higher helps dense text and complex layouts.'
                        )}
                    </p>
                </div>
            )}

            <div className='space-y-3'>
                <Label className='text-foreground block'>{t('Background')}</Label>
                <RadioGroup
                    value={background}
                    onValueChange={(value) => setBackground(value as ImageBackground)}
                    disabled={disabled}
                    className='flex flex-wrap gap-x-5 gap-y-3'>
                    <RadioItemWithIcon value='auto' id={id('bg-auto')} label={t('Auto')} Icon={Sparkles} />
                    <RadioItemWithIcon value='opaque' id={id('bg-opaque')} label={t('Opaque')} Icon={BrickWall} />
                    <RadioItemWithIcon
                        value='transparent'
                        id={id('bg-transparent')}
                        label={t('Transparent')}
                        Icon={Eraser}
                    />
                </RadioGroup>
            </div>

            <div className='space-y-3'>
                <Label className='text-foreground block'>{t('Output Format')}</Label>
                <RadioGroup
                    value={outputFormat}
                    onValueChange={handleOutputFormatChange}
                    disabled={disabled}
                    className='flex flex-wrap gap-x-5 gap-y-3'>
                    {availableFormats.map((format) => (
                        <RadioItemWithIcon
                            key={format}
                            value={format}
                            id={id(`format-${format}`)}
                            label={FORMAT_OPTIONS[format].label}
                            Icon={FORMAT_OPTIONS[format].Icon}
                        />
                    ))}
                </RadioGroup>
            </div>

            {showCompression && (
                <div className='space-y-2 pt-2 transition-opacity duration-300'>
                    <Label htmlFor={id('compression-slider')} className='text-foreground'>
                        {t('Compression:')} {compression[0]}%
                    </Label>
                    <Slider
                        id={id('compression-slider')}
                        min={0}
                        max={100}
                        step={1}
                        value={compression}
                        onValueChange={setCompression}
                        disabled={disabled}
                        className={SLIDER_CLASS}
                    />
                </div>
            )}

            {isGif && (
                <div className='border-foreground/10 bg-foreground/5 space-y-4 rounded-md border p-3'>
                    <div className='space-y-2'>
                        <Label htmlFor={id('frame-count-slider')} className='text-foreground'>
                            {t('Frames:')} {frameCount}
                        </Label>
                        <Slider
                            id={id('frame-count-slider')}
                            min={GIF_FRAME_COUNT.min}
                            max={GIF_FRAME_COUNT.max}
                            step={1}
                            value={[frameCount]}
                            onValueChange={([value]) => setFrameCount(value)}
                            disabled={disabled}
                            className={SLIDER_CLASS}
                        />
                    </div>
                    <div className='space-y-2'>
                        <Label htmlFor={id('frame-duration-slider')} className='text-foreground'>
                            {t('Frame Duration:')} {frameDurationMs} {t('ms')}
                        </Label>
                        <Slider
                            id={id('frame-duration-slider')}
                            min={GIF_FRAME_DURATION_MS.min}
                            max={GIF_FRAME_DURATION_MS.max}
                            step={GIF_FRAME_DURATION_MS.step}
                            value={[frameDurationMs]}
                            onValueChange={([value]) => setFrameDurationMs(value)}
                            disabled={disabled}
                            className={SLIDER_CLASS}
                        />
                    </div>
                    <p className='text-foreground/50 text-xs'>
                        {loopSeconds.toFixed(2)}
                        {t('s loop at')} {(1000 / frameDurationMs).toFixed(1)}{' '}
                        {t('fps. Describe the motion and how it loops in the prompt.')}
                    </p>
                </div>
            )}

            {outputFormat === 'svg' && svg && (
                <div className='border-foreground/10 bg-foreground/5 space-y-4 rounded-md border p-3'>
                    <div className='space-y-1.5'>
                        <Label htmlFor={id('svg-model-select')} className='text-foreground'>
                            {t('SVG Writer Model')}
                        </Label>
                        <Select
                            value={svg.model}
                            onValueChange={(value) => {
                                const writer = value as SvgWriterModel;
                                svg.setModel(writer);
                                // Keep the effort only if the new writer accepts it.
                                if (
                                    svg.effort &&
                                    !(SVG_WRITER_MODELS[writer] as readonly SvgReasoningEffort[]).includes(svg.effort)
                                ) {
                                    svg.setEffort(null);
                                }
                            }}
                            disabled={disabled}>
                            <SelectTrigger
                                id={id('svg-model-select')}
                                className='border-foreground/20 bg-background text-foreground focus:border-foreground/50 focus:ring-foreground/50 w-[220px] rounded-md border'>
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent className='border-foreground/20 bg-background text-foreground'>
                                {(Object.keys(SVG_WRITER_MODELS) as SvgWriterModel[]).map((writer) => (
                                    <SelectItem key={writer} value={writer} className='focus:bg-foreground/10'>
                                        {writer}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>
                    <div className='space-y-3'>
                        <Label className='text-foreground block'>{t('Writer Reasoning')}</Label>
                        <RadioGroup
                            value={svg.effort ?? 'default'}
                            onValueChange={(value) =>
                                svg.setEffort(value === 'default' ? null : (value as SvgReasoningEffort))
                            }
                            disabled={disabled}
                            className='flex flex-wrap gap-x-5 gap-y-3'>
                            <RadioItemWithIcon
                                value='default'
                                id={id('svg-effort-default')}
                                label={t('Default')}
                                Icon={Sparkles}
                            />
                            {SVG_WRITER_MODELS[svg.model].map((effort) => (
                                <RadioItemWithIcon
                                    key={effort}
                                    value={effort}
                                    id={id(`svg-effort-${effort}`)}
                                    label={effort}
                                    Icon={Brain}
                                />
                            ))}
                        </RadioGroup>
                    </div>
                    <p className='text-foreground/50 text-xs'>
                        {t(
                            'The image model draws a reference image; the writer model turns it into SVG. Quality and complexity apply to the reference image. One image per request.'
                        )}
                    </p>
                </div>
            )}

            <div className='space-y-3'>
                <Label className='text-foreground block'>{t('Moderation Level')}</Label>
                <RadioGroup
                    value={moderation}
                    onValueChange={(value) => setModeration(value as ImageModeration)}
                    disabled={disabled}
                    className='flex flex-wrap gap-x-5 gap-y-3'>
                    <RadioItemWithIcon value='auto' id={id('mod-auto')} label={t('Auto')} Icon={ShieldCheck} />
                    <RadioItemWithIcon value='low' id={id('mod-low')} label={t('Low')} Icon={ShieldAlert} />
                </RadioGroup>
            </div>
        </>
    );
}
