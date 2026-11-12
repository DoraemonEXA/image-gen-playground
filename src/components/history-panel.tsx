'use client';

import type { HistoryMetadata } from '@/app/page';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import {
    Dialog,
    DialogClose,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    DialogTrigger
} from '@/components/ui/dialog';
import { getModelRates, getSvgWriterRates, type ModelRates, tokensToUsd } from '@/lib/cost-utils';
import { GPT_IMAGE_MODELS, type GptImageModel } from '@/lib/models';
import { cn } from '@/lib/utils';
import { usePreferences } from '@/modules/preferences/client';
import {
    Check,
    Copy,
    Database,
    DollarSign,
    FileImage,
    HardDrive,
    Layers,
    Pencil,
    Sparkles as SparklesIcon,
    Trash2
} from 'lucide-react';
import Image from 'next/image';
import * as React from 'react';

type HistoryPanelProps = {
    history: HistoryMetadata[];
    totalSummary?: { totalCost: number; totalImages: number };
    onSelectImage: (item: HistoryMetadata) => void;
    onClearHistory: () => void;
    getImageSrc: (filename: string) => string | undefined;
    onDeleteItemRequest: (item: HistoryMetadata) => void;
    itemPendingDeleteConfirmation: HistoryMetadata | null;
    onConfirmDeletion: () => void;
    onCancelDeletion: () => void;
    deletePreferenceDialogValue: boolean;
    onDeletePreferenceDialogChange: (isChecked: boolean) => void;
};

const formatDuration = (ms: number): string => {
    if (ms < 1000) {
        return `${ms}ms`;
    }
    return `${(ms / 1000).toFixed(1)}s`;
};

const formatUsd = (tokens: number, perMillion: number): string => tokensToUsd(tokens, perMillion).toFixed(4);

// Selectable models grouped by identical pricing, for the total-cost summary.
const RATE_GROUPS = GPT_IMAGE_MODELS.reduce<{ rates: ModelRates; models: GptImageModel[] }[]>((groups, model) => {
    const rates = getModelRates(model);
    const group = groups.find(
        (g) =>
            g.rates.textInputPerMillion === rates.textInputPerMillion &&
            g.rates.imageInputPerMillion === rates.imageInputPerMillion &&
            g.rates.imageOutputPerMillion === rates.imageOutputPerMillion
    );
    if (group) {
        group.models.push(model);
    } else {
        groups.push({ rates, models: [model] });
    }
    return groups;
}, []);

function HistoryPanelImpl({
    history,
    totalSummary,
    onSelectImage,
    onClearHistory,
    getImageSrc,
    onDeleteItemRequest,
    itemPendingDeleteConfirmation,
    onConfirmDeletion,
    onCancelDeletion,
    deletePreferenceDialogValue,
    onDeletePreferenceDialogChange
}: HistoryPanelProps) {
    const { t, locale } = usePreferences();
    const [openPromptDialogTimestamp, setOpenPromptDialogTimestamp] = React.useState<string | number | null>(null);
    const [openCostDialogTimestamp, setOpenCostDialogTimestamp] = React.useState<string | number | null>(null);
    const [isTotalCostDialogOpen, setIsTotalCostDialogOpen] = React.useState(false);
    const [copiedTimestamp, setCopiedTimestamp] = React.useState<string | number | null>(null);

    const { totalCost, totalImages } = React.useMemo(() => {
        if (totalSummary) return totalSummary;
        let cost = 0;
        let images = 0;
        history.forEach((item) => {
            if (item.costDetails) {
                cost += item.costDetails.estimated_cost_usd;
            }
            images += item.images?.length ?? 0;
        });

        return { totalCost: Math.round(cost * 10000) / 10000, totalImages: images };
    }, [history, totalSummary]);

    const averageCost = totalImages > 0 ? totalCost / totalImages : 0;

    const handleCopy = async (text: string | null | undefined, timestamp: string | number) => {
        if (!text) return;
        try {
            await navigator.clipboard.writeText(text);
            setCopiedTimestamp(timestamp);
            setTimeout(() => setCopiedTimestamp(null), 1500);
        } catch (err) {
            console.error('Failed to copy text: ', err);
        }
    };

    return (
        <Card className='border-foreground/10 bg-background flex h-full w-full flex-col overflow-hidden rounded-lg border'>
            <CardHeader className='border-foreground/10 flex flex-row items-center justify-between gap-4 border-b px-4 py-3'>
                <div className='flex items-center gap-2'>
                    <CardTitle className='text-foreground text-lg font-medium'>{t('History')}</CardTitle>
                    {totalCost > 0 && (
                        <Dialog open={isTotalCostDialogOpen} onOpenChange={setIsTotalCostDialogOpen}>
                            <DialogTrigger asChild>
                                <button
                                    className='text-foreground mt-0.5 flex items-center gap-1 rounded-full bg-green-600/80 px-1.5 py-0.5 text-[12px] transition-colors hover:bg-green-500/90'
                                    aria-label={t('Show total cost summary')}>
                                    {t('Total Cost: $')}
                                    {totalCost.toFixed(4)}
                                </button>
                            </DialogTrigger>
                            <DialogContent className='border-border bg-card text-foreground sm:max-w-[450px]'>
                                <DialogHeader>
                                    <DialogTitle className='text-foreground'>{t('Total Cost Summary')}</DialogTitle>
                                    {/* Add sr-only description for accessibility */}
                                    <DialogDescription className='sr-only'>
                                        {t(
                                            'A summary of the total estimated cost for all generated images in the history.'
                                        )}
                                    </DialogDescription>
                                </DialogHeader>
                                <div className='text-muted-foreground space-y-2 pt-1 text-xs'>
                                    {RATE_GROUPS.map(({ rates, models }) => (
                                        <div key={models.join(',')} className='space-y-1'>
                                            <p className='font-medium'>{models.join(', ')}:</p>
                                            <ul className='list-disc pl-4'>
                                                <li>
                                                    {t('Text Input: $')}
                                                    {rates.textInputPerMillion} {t('/ 1M tokens')}
                                                </li>
                                                <li>
                                                    {t('Image Input: $')}
                                                    {rates.imageInputPerMillion} {t('/ 1M tokens')}
                                                </li>
                                                <li>
                                                    {t('Image Output: $')}
                                                    {rates.imageOutputPerMillion} {t('/ 1M tokens')}
                                                </li>
                                            </ul>
                                        </div>
                                    ))}
                                </div>
                                <div className='text-muted-foreground space-y-2 py-4 text-sm'>
                                    <div className='flex justify-between'>
                                        <span>{t('Total Images Generated:')}</span>{' '}
                                        <span>{totalImages.toLocaleString(locale)}</span>
                                    </div>
                                    <div className='flex justify-between'>
                                        <span>{t('Average Cost Per Image:')}</span>{' '}
                                        <span>${averageCost.toFixed(4)}</span>
                                    </div>
                                    <hr className='border-border my-2' />
                                    <div className='text-foreground flex justify-between font-medium'>
                                        <span>{t('Total Estimated Cost:')}</span>
                                        <span>${totalCost.toFixed(4)}</span>
                                    </div>
                                </div>
                                <DialogFooter>
                                    <DialogClose asChild>
                                        <Button
                                            type='button'
                                            variant='secondary'
                                            size='sm'
                                            className='bg-accent text-foreground hover:bg-accent'>
                                            {t('Close')}
                                        </Button>
                                    </DialogClose>
                                </DialogFooter>
                            </DialogContent>
                        </Dialog>
                    )}
                </div>
                {history.length > 0 && (
                    <Button
                        variant='ghost'
                        size='sm'
                        onClick={onClearHistory}
                        className='text-foreground/60 hover:bg-foreground/10 hover:text-foreground h-auto rounded-md px-2 py-1'>
                        {t('Clear')}
                    </Button>
                )}
            </CardHeader>
            <CardContent className='flex-grow overflow-y-auto p-4'>
                {history.length === 0 ? (
                    <div className='text-foreground/40 flex h-full items-center justify-center'>
                        <p>{t('Generated images will appear here.')}</p>
                    </div>
                ) : (
                    <div className='grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5'>
                        {[...history].map((item) => {
                            const firstImage = item.images?.[0];
                            const imageCount = item.images?.length ?? 0;
                            const isMultiImage = imageCount > 1;
                            const itemKey = item.id ?? item.timestamp;
                            const originalStorageMode = item.storageModeUsed || 'fs';
                            const outputFormat = item.output_format || 'png';
                            const model = item.model ?? 'gpt-image-1';

                            let thumbnailUrl: string | undefined;
                            if (firstImage) {
                                if (originalStorageMode === 'indexeddb') {
                                    thumbnailUrl = getImageSrc(firstImage.filename);
                                } else {
                                    thumbnailUrl = `/api/image/${firstImage.filename}`;
                                }
                            }

                            return (
                                <div key={itemKey} className='flex flex-col'>
                                    {item.state && item.state !== 'complete' && (
                                        <p className='text-warning text-xs'>
                                            {t('Saved result ·')} {t(item.state ?? '')}
                                        </p>
                                    )}
                                    {item.accounting === 'needs_reconciliation' && (
                                        <p className='text-warning text-xs'>{t('Cost awaiting reconciliation')}</p>
                                    )}
                                    <div className='group relative'>
                                        <button
                                            onClick={() => onSelectImage(item)}
                                            className='border-foreground/20 group-hover:border-foreground/40 focus:ring-foreground focus:ring-offset-background relative block aspect-square w-full overflow-hidden rounded-t-md border transition-all duration-150 focus:ring-2 focus:ring-offset-2 focus:outline-none'
                                            aria-label={t('View image batch from {v0}', {
                                                v0: new Date(item.timestamp).toLocaleString(locale)
                                            })}>
                                            {thumbnailUrl ? (
                                                <Image
                                                    src={thumbnailUrl}
                                                    alt={t('Preview for batch generated at {v0}', {
                                                        v0: new Date(item.timestamp).toLocaleString(locale)
                                                    })}
                                                    width={150}
                                                    height={150}
                                                    className='h-full w-full object-cover'
                                                    unoptimized
                                                />
                                            ) : (
                                                <div className='bg-muted text-muted-foreground flex h-full w-full items-center justify-center'>
                                                    ?
                                                </div>
                                            )}
                                            <div
                                                className={cn(
                                                    'text-foreground pointer-events-none absolute top-1 left-1 z-10 flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[11px]',
                                                    item.mode === 'edit' ? 'bg-orange-600/80' : 'bg-blue-600/80'
                                                )}>
                                                {item.mode === 'edit' ? (
                                                    <Pencil size={12} />
                                                ) : (
                                                    <SparklesIcon size={12} />
                                                )}
                                                {item.mode === 'edit' ? t('Edit') : t('Create')}
                                            </div>
                                            {isMultiImage && (
                                                <div className='pointer-events-none absolute right-1 bottom-1 z-10 flex items-center gap-1 rounded-full bg-black/70 px-1.5 py-0.5 text-[12px] text-white'>
                                                    <Layers size={16} />
                                                    {imageCount}
                                                </div>
                                            )}
                                            <div className='pointer-events-none absolute bottom-1 left-1 z-10 flex items-center gap-1'>
                                                <div className='border-foreground/10 bg-card/80 text-foreground/70 flex items-center gap-1 rounded-full border px-1 py-0.5 text-[11px]'>
                                                    {originalStorageMode === 'fs' ? (
                                                        <HardDrive size={12} className='text-muted-foreground' />
                                                    ) : (
                                                        <Database size={12} className='text-info' />
                                                    )}
                                                    <span>{originalStorageMode === 'fs' ? t('file') : t('db')}</span>
                                                </div>
                                                {item.output_format && (
                                                    <div className='border-foreground/10 bg-card/80 text-foreground/70 flex items-center gap-1 rounded-full border px-1 py-0.5 text-[11px]'>
                                                        <FileImage size={12} className='text-muted-foreground' />
                                                        <span>{outputFormat.toUpperCase()}</span>
                                                    </div>
                                                )}
                                            </div>
                                        </button>
                                        {item.costDetails && (
                                            <Dialog
                                                open={openCostDialogTimestamp === itemKey}
                                                onOpenChange={(isOpen) => !isOpen && setOpenCostDialogTimestamp(null)}>
                                                <DialogTrigger asChild>
                                                    <button
                                                        onClick={(e) => {
                                                            e.stopPropagation();
                                                            setOpenCostDialogTimestamp(itemKey);
                                                        }}
                                                        className='text-foreground absolute top-1 right-1 z-20 flex items-center gap-0.5 rounded-full bg-green-600/80 px-1.5 py-0.5 text-[11px] transition-colors hover:bg-green-500/90'
                                                        aria-label={t('Show cost breakdown')}>
                                                        <DollarSign size={12} />
                                                        {item.costDetails.estimated_cost_usd.toFixed(4)}
                                                    </button>
                                                </DialogTrigger>
                                                <DialogContent className='border-border bg-card text-foreground sm:max-w-[450px]'>
                                                    <DialogHeader>
                                                        <DialogTitle className='text-foreground'>
                                                            {t('Cost Breakdown')}
                                                        </DialogTitle>
                                                        <DialogDescription className='sr-only'>
                                                            {t('Estimated cost breakdown for this image generation.')}
                                                        </DialogDescription>
                                                    </DialogHeader>
                                                    {(() => {
                                                        const rates = getModelRates(model);
                                                        const svgWriter = item.costDetails.svg_writer && {
                                                            ...item.costDetails.svg_writer,
                                                            rates: getSvgWriterRates(item.costDetails.svg_writer.model)
                                                        };
                                                        return (
                                                            <>
                                                                <div className='text-muted-foreground space-y-1 pt-1 text-xs'>
                                                                    <p>
                                                                        {t('Pricing for')} {model}:
                                                                    </p>
                                                                    <ul className='list-disc pl-4'>
                                                                        <li>
                                                                            {t('Text Input: $')}
                                                                            {rates.textInputPerMillion}{' '}
                                                                            {t('/ 1M tokens')}
                                                                        </li>
                                                                        <li>
                                                                            {t('Image Input: $')}
                                                                            {rates.imageInputPerMillion}{' '}
                                                                            {t('/ 1M tokens')}
                                                                        </li>
                                                                        <li>
                                                                            {t('Image Output: $')}
                                                                            {rates.imageOutputPerMillion}{' '}
                                                                            {t('/ 1M tokens')}
                                                                        </li>
                                                                    </ul>
                                                                    {svgWriter && (
                                                                        <>
                                                                            <p>
                                                                                {t('Pricing for')} {svgWriter.model}:
                                                                            </p>
                                                                            <ul className='list-disc pl-4'>
                                                                                <li>
                                                                                    {t('Input: $')}
                                                                                    {
                                                                                        svgWriter.rates.inputPerMillion
                                                                                    }{' '}
                                                                                    {t('/ 1M tokens')}
                                                                                </li>
                                                                                <li>
                                                                                    {t('Output: $')}
                                                                                    {
                                                                                        svgWriter.rates.outputPerMillion
                                                                                    }{' '}
                                                                                    {t('/ 1M tokens')}
                                                                                </li>
                                                                            </ul>
                                                                        </>
                                                                    )}
                                                                </div>
                                                                <div className='text-muted-foreground space-y-2 py-4 text-sm'>
                                                                    <div className='flex justify-between'>
                                                                        <span>{t('Text Input Tokens:')}</span>{' '}
                                                                        <span>
                                                                            {item.costDetails.text_input_tokens.toLocaleString(
                                                                                locale
                                                                            )}{' '}
                                                                            (~$
                                                                            {formatUsd(
                                                                                item.costDetails.text_input_tokens,
                                                                                rates.textInputPerMillion
                                                                            )}
                                                                            )
                                                                        </span>
                                                                    </div>
                                                                    {item.costDetails.image_input_tokens > 0 && (
                                                                        <div className='flex justify-between'>
                                                                            <span>{t('Image Input Tokens:')}</span>{' '}
                                                                            <span>
                                                                                {item.costDetails.image_input_tokens.toLocaleString(
                                                                                    locale
                                                                                )}{' '}
                                                                                (~$
                                                                                {formatUsd(
                                                                                    item.costDetails.image_input_tokens,
                                                                                    rates.imageInputPerMillion
                                                                                )}
                                                                                )
                                                                            </span>
                                                                        </div>
                                                                    )}
                                                                    <div className='flex justify-between'>
                                                                        <span>{t('Image Output Tokens:')}</span>{' '}
                                                                        <span>
                                                                            {item.costDetails.image_output_tokens.toLocaleString(
                                                                                locale
                                                                            )}{' '}
                                                                            (~$
                                                                            {formatUsd(
                                                                                item.costDetails.image_output_tokens,
                                                                                rates.imageOutputPerMillion
                                                                            )}
                                                                            )
                                                                        </span>
                                                                    </div>
                                                                    {svgWriter && (
                                                                        <>
                                                                            <div className='flex justify-between'>
                                                                                <span>
                                                                                    {t('SVG Writer Input (')}
                                                                                    {svgWriter.model}
                                                                                    ):
                                                                                </span>{' '}
                                                                                <span>
                                                                                    {svgWriter.input_tokens.toLocaleString(
                                                                                        locale
                                                                                    )}{' '}
                                                                                    (~$
                                                                                    {formatUsd(
                                                                                        svgWriter.input_tokens,
                                                                                        svgWriter.rates.inputPerMillion
                                                                                    )}
                                                                                    )
                                                                                </span>
                                                                            </div>
                                                                            <div className='flex justify-between'>
                                                                                <span>{t('SVG Writer Output:')}</span>{' '}
                                                                                <span>
                                                                                    {svgWriter.output_tokens.toLocaleString(
                                                                                        locale
                                                                                    )}{' '}
                                                                                    (~$
                                                                                    {formatUsd(
                                                                                        svgWriter.output_tokens,
                                                                                        svgWriter.rates.outputPerMillion
                                                                                    )}
                                                                                    )
                                                                                </span>
                                                                            </div>
                                                                        </>
                                                                    )}
                                                                    <hr className='border-border my-2' />
                                                                    <div className='text-foreground flex justify-between font-medium'>
                                                                        <span>{t('Total Estimated Cost:')}</span>
                                                                        <span>
                                                                            $
                                                                            {item.costDetails.estimated_cost_usd.toFixed(
                                                                                4
                                                                            )}
                                                                        </span>
                                                                    </div>
                                                                </div>
                                                            </>
                                                        );
                                                    })()}
                                                    <DialogFooter>
                                                        <DialogClose asChild>
                                                            <Button
                                                                type='button'
                                                                variant='secondary'
                                                                size='sm'
                                                                className='bg-accent text-foreground hover:bg-accent'>
                                                                {t('Close')}
                                                            </Button>
                                                        </DialogClose>
                                                    </DialogFooter>
                                                </DialogContent>
                                            </Dialog>
                                        )}
                                    </div>

                                    <div className='border-border bg-background text-foreground/60 space-y-1 rounded-b-md border border-t-0 p-2 text-xs'>
                                        <p
                                            title={t('Generated on: {v0}', {
                                                v0: new Date(item.timestamp).toLocaleString(locale)
                                            })}>
                                            <span className='text-foreground/80 font-medium'>{t('Time:')}</span>{' '}
                                            {formatDuration(item.durationMs)}
                                        </p>
                                        <p>
                                            <span className='text-foreground/80 font-medium'>{t('Model:')}</span>{' '}
                                            {model}
                                        </p>
                                        <p>
                                            <span className='text-foreground/80 font-medium'>{t('Quality:')}</span>{' '}
                                            {t(item.quality)}
                                        </p>
                                        {item.complexity && (
                                            <p>
                                                <span className='text-foreground/80 font-medium'>
                                                    {t('Complexity:')}
                                                </span>{' '}
                                                {t(item.complexity)}
                                            </p>
                                        )}
                                        {item.frame_count && (
                                            <p>
                                                <span className='text-foreground/80 font-medium'>{t('Frames:')}</span>{' '}
                                                {item.frame_count} 脳 {item.frame_duration_ms}
                                                {t('ms')}
                                            </p>
                                        )}
                                        <p>
                                            <span className='text-foreground/80 font-medium'>{t('BG:')}</span>{' '}
                                            {t(item.background)}
                                        </p>
                                        <p>
                                            <span className='text-foreground/80 font-medium'>{t('Mod:')}</span>{' '}
                                            {t(item.moderation)}
                                        </p>
                                        <div className='mt-2 flex items-center gap-1'>
                                            <Dialog
                                                open={openPromptDialogTimestamp === itemKey}
                                                onOpenChange={(isOpen) =>
                                                    !isOpen && setOpenPromptDialogTimestamp(null)
                                                }>
                                                <DialogTrigger asChild>
                                                    <Button
                                                        variant='outline'
                                                        size='sm'
                                                        className='border-foreground/20 text-foreground/70 hover:bg-foreground/10 hover:text-foreground h-6 flex-grow px-2 py-1 text-xs'
                                                        onClick={() => setOpenPromptDialogTimestamp(itemKey)}>
                                                        {t('Show Prompt')}
                                                    </Button>
                                                </DialogTrigger>
                                                <DialogContent className='border-border bg-card text-foreground sm:max-w-[625px]'>
                                                    <DialogHeader>
                                                        <DialogTitle className='text-foreground'>
                                                            {t('Prompt')}
                                                        </DialogTitle>
                                                        <DialogDescription className='sr-only'>
                                                            {t('The full prompt used to generate this image batch.')}
                                                        </DialogDescription>
                                                    </DialogHeader>
                                                    <div className='border-border bg-muted text-muted-foreground max-h-[400px] overflow-y-auto rounded-md border p-3 py-4 text-sm'>
                                                        {item.prompt || t('No prompt recorded.')}
                                                    </div>
                                                    <DialogFooter>
                                                        <Button
                                                            variant='outline'
                                                            size='sm'
                                                            onClick={() => handleCopy(item.prompt, itemKey)}
                                                            className='border-border text-muted-foreground hover:bg-accent hover:text-foreground'>
                                                            {copiedTimestamp === itemKey ? (
                                                                <Check className='text-success mr-2 h-4 w-4' />
                                                            ) : (
                                                                <Copy className='mr-2 h-4 w-4' />
                                                            )}
                                                            {copiedTimestamp === itemKey ? t('Copied!') : t('Copy')}
                                                        </Button>
                                                        <DialogClose asChild>
                                                            <Button
                                                                type='button'
                                                                variant='secondary'
                                                                size='sm'
                                                                className='bg-accent text-foreground hover:bg-accent'>
                                                                {t('Close')}
                                                            </Button>
                                                        </DialogClose>
                                                    </DialogFooter>
                                                </DialogContent>
                                            </Dialog>
                                            <Dialog
                                                open={itemPendingDeleteConfirmation?.timestamp === item.timestamp}
                                                onOpenChange={(isOpen) => {
                                                    if (!isOpen) onCancelDeletion();
                                                }}>
                                                <DialogTrigger asChild>
                                                    <Button
                                                        className='h-6 w-6 bg-red-700/60 text-white hover:bg-red-600/60'
                                                        onClick={(e) => {
                                                            e.stopPropagation();
                                                            onDeleteItemRequest(item);
                                                        }}
                                                        aria-label={t('Delete history item')}>
                                                        <Trash2 size={14} />
                                                    </Button>
                                                </DialogTrigger>
                                                <DialogContent className='border-border bg-card text-foreground sm:max-w-md'>
                                                    <DialogHeader>
                                                        <DialogTitle className='text-foreground'>
                                                            {t('Confirm Deletion')}
                                                        </DialogTitle>
                                                        <DialogDescription className='text-muted-foreground pt-2'>
                                                            {t(
                                                                'Are you sure you want to delete this history entry? This will remove'
                                                            )}{' '}
                                                            {item.images.length}{' '}
                                                            {t('image(s). This action cannot be undone.')}
                                                        </DialogDescription>
                                                    </DialogHeader>
                                                    <div className='flex items-center space-x-2 py-2'>
                                                        <Checkbox
                                                            id={`dont-ask-${item.timestamp}`}
                                                            checked={deletePreferenceDialogValue}
                                                            onCheckedChange={(checked) =>
                                                                onDeletePreferenceDialogChange(!!checked)
                                                            }
                                                            className='border-border bg-foreground data-[state=checked]:border-border data-[state=checked]:bg-foreground data-[state=checked]:text-background dark:border-border dark:!bg-foreground'
                                                        />
                                                        <label
                                                            htmlFor={`dont-ask-${item.timestamp}`}
                                                            className='text-muted-foreground text-sm leading-none font-medium peer-disabled:cursor-not-allowed peer-disabled:opacity-70'>
                                                            {t("Don't ask me again")}
                                                        </label>
                                                    </div>
                                                    <DialogFooter className='gap-2 sm:justify-end'>
                                                        <Button
                                                            type='button'
                                                            variant='outline'
                                                            size='sm'
                                                            onClick={onCancelDeletion}
                                                            className='border-border text-muted-foreground hover:bg-accent hover:text-foreground'>
                                                            {t('Cancel')}
                                                        </Button>
                                                        <Button
                                                            type='button'
                                                            variant='destructive'
                                                            size='sm'
                                                            onClick={onConfirmDeletion}
                                                            className='bg-red-600 text-white hover:bg-red-500'>
                                                            {t('Delete')}
                                                        </Button>
                                                    </DialogFooter>
                                                </DialogContent>
                                            </Dialog>
                                        </div>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                )}
            </CardContent>
        </Card>
    );
}

export const HistoryPanel = React.memo(HistoryPanelImpl);
