'use client';

import { Button } from '@/components/ui/button';
import { EDIT_INPUT_FORMATS, type ImageMode, type ImageOutputFormat } from '@/lib/models';
import { cn } from '@/lib/utils';
import { usePreferences } from '@/modules/preferences/client';
import { Grid, Loader2, Send } from 'lucide-react';
import Image from 'next/image';
import * as React from 'react';

function ElapsedTimer({ startTime, className }: { startTime: number; className?: string }) {
    const { t } = usePreferences();
    const [now, setNow] = React.useState(() => Date.now());
    React.useEffect(() => {
        const id = setInterval(() => setNow(Date.now()), 100);
        return () => clearInterval(id);
    }, []);
    return (
        <span className={cn('tabular-nums', className)}>
            {Math.max(0, (now - startTime) / 1000).toFixed(1)}
            {t('s')}
        </span>
    );
}

type ImageInfo = {
    path: string;
    filename: string;
};

type ImageOutputProps = {
    imageBatch: ImageInfo[] | null;
    viewMode: 'grid' | number;
    onViewChange: (view: 'grid' | number) => void;
    altText?: string;
    isLoading: boolean;
    loadingStartTime: number | null;
    onSendToEdit: (filename: string) => void;
    currentMode: ImageMode;
    baseImagePreviewUrl: string | null;
    streamingPreviewImages?: Map<number, string>;
};

const getGridColsClass = (count: number): string => {
    if (count <= 1) return 'grid-cols-1';
    if (count <= 4) return 'grid-cols-2';
    if (count <= 9) return 'grid-cols-3';
    return 'grid-cols-3';
};

export function ImageOutput({
    imageBatch,
    viewMode,
    onViewChange,
    altText = 'Generated image output',
    isLoading,
    loadingStartTime,
    onSendToEdit,
    currentMode,
    baseImagePreviewUrl,
    streamingPreviewImages
}: ImageOutputProps) {
    const { t } = usePreferences();
    const handleSendClick = () => {
        // Send to edit only works when a single image is selected
        if (typeof viewMode === 'number' && imageBatch && imageBatch[viewMode]) {
            onSendToEdit(imageBatch[viewMode].filename);
        }
    };

    const showCarousel = imageBatch && imageBatch.length > 1;
    const isSingleImageView = typeof viewMode === 'number';
    const selectedImage = isSingleImageView && imageBatch ? imageBatch[viewMode] : undefined;
    // Filenames end in the output format.
    const canSendToEdit =
        !isLoading &&
        !!selectedImage &&
        EDIT_INPUT_FORMATS.includes(selectedImage.filename.split('.').pop() as ImageOutputFormat);

    return (
        <div className='border-foreground/20 bg-background flex h-full min-h-[300px] w-full flex-col items-center justify-between gap-4 overflow-hidden rounded-lg border p-4'>
            <div className='relative flex h-full w-full flex-grow items-center justify-center overflow-hidden'>
                {isLoading ? (
                    streamingPreviewImages && streamingPreviewImages.size > 0 ? (
                        // Show streaming preview images - single image centered like final view
                        <div className='relative flex h-full w-full items-center justify-center'>
                            {/* Show the latest preview image (highest index) */}
                            {(() => {
                                const entries = Array.from(streamingPreviewImages.entries());
                                const latestEntry = entries[entries.length - 1];
                                if (!latestEntry) return null;
                                const [, dataUrl] = latestEntry;
                                return (
                                    <Image
                                        src={dataUrl}
                                        alt={t('Streaming preview')}
                                        width={512}
                                        height={512}
                                        className='max-h-full max-w-full object-contain'
                                        unoptimized
                                    />
                                );
                            })()}
                            {/* Overlay loader at bottom center */}
                            <div className='absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-full bg-black/70 px-3 py-1.5 text-white/80'>
                                <Loader2 className='h-4 w-4 animate-spin' />
                                <p className='text-sm'>{t('Streaming...')}</p>
                                {loadingStartTime !== null && (
                                    <ElapsedTimer startTime={loadingStartTime} className='text-sm text-white/70' />
                                )}
                            </div>
                        </div>
                    ) : currentMode === 'edit' && baseImagePreviewUrl ? (
                        <div className='relative flex h-full w-full items-center justify-center'>
                            <Image
                                src={baseImagePreviewUrl}
                                alt={t('Base image for editing')}
                                fill
                                style={{ objectFit: 'contain' }}
                                className='blur-md filter'
                                unoptimized
                            />
                            <div className='bg-background/50 text-foreground/80 absolute inset-0 flex flex-col items-center justify-center'>
                                <Loader2 className='mb-2 h-8 w-8 animate-spin' />
                                <p>{t('Editing image...')}</p>
                                {loadingStartTime !== null && (
                                    <ElapsedTimer
                                        startTime={loadingStartTime}
                                        className='text-foreground/50 mt-1 text-sm'
                                    />
                                )}
                            </div>
                        </div>
                    ) : (
                        <div className='text-foreground/60 flex flex-col items-center justify-center'>
                            <Loader2 className='mb-2 h-8 w-8 animate-spin' />
                            <p>{t('Generating image...')}</p>
                            {loadingStartTime !== null && (
                                <ElapsedTimer
                                    startTime={loadingStartTime}
                                    className='text-foreground/40 mt-1 text-sm'
                                />
                            )}
                        </div>
                    )
                ) : imageBatch && imageBatch.length > 0 ? (
                    viewMode === 'grid' ? (
                        <div
                            className={`grid ${getGridColsClass(imageBatch.length)} max-h-full w-full max-w-full gap-1 p-1`}>
                            {imageBatch.map((img, index) => (
                                <div
                                    key={img.filename}
                                    className='border-foreground/10 relative aspect-square overflow-hidden rounded border'>
                                    <Image
                                        src={img.path}
                                        alt={t('Generated image {v0}', { v0: index + 1 })}
                                        fill
                                        style={{ objectFit: 'contain' }}
                                        sizes='(max-width: 768px) 50vw, (max-width: 1024px) 33vw, 25vw'
                                        unoptimized
                                    />
                                </div>
                            ))}
                        </div>
                    ) : imageBatch[viewMode] ? (
                        <Image
                            src={imageBatch[viewMode].path}
                            alt={t(altText)}
                            width={512}
                            height={512}
                            className='max-h-full max-w-full object-contain'
                            unoptimized
                        />
                    ) : (
                        <div className='text-foreground/40 text-center'>
                            <p>{t('Error displaying image.')}</p>
                        </div>
                    )
                ) : (
                    <div className='text-foreground/40 text-center'>
                        <p>{t('Your generated image will appear here.')}</p>
                    </div>
                )}
            </div>

            <div className='flex h-10 w-full shrink-0 items-center justify-center gap-4'>
                {showCarousel && (
                    <div className='border-foreground/10 bg-muted/50 flex items-center gap-1.5 rounded-md border p-1'>
                        <Button
                            variant='ghost'
                            size='icon'
                            className={cn(
                                'h-8 w-8 rounded p-1',
                                viewMode === 'grid'
                                    ? 'bg-foreground/20 text-foreground'
                                    : 'text-foreground/50 hover:bg-foreground/10 hover:text-foreground/80'
                            )}
                            onClick={() => onViewChange('grid')}
                            aria-label={t('Show grid view')}>
                            <Grid className='h-4 w-4' />
                        </Button>
                        {imageBatch.map((img, index) => (
                            <Button
                                key={img.filename}
                                variant='ghost'
                                size='icon'
                                className={cn(
                                    'h-8 w-8 overflow-hidden rounded p-0.5',
                                    viewMode === index
                                        ? 'ring-foreground ring-offset-background ring-2 ring-offset-1'
                                        : 'opacity-60 hover:opacity-100'
                                )}
                                onClick={() => onViewChange(index)}
                                aria-label={t('Select image {v0}', { v0: index + 1 })}>
                                <Image
                                    src={img.path}
                                    alt={t('Thumbnail {v0}', { v0: index + 1 })}
                                    width={28}
                                    height={28}
                                    className='h-full w-full object-cover'
                                    unoptimized
                                />
                            </Button>
                        ))}
                    </div>
                )}

                <Button
                    variant='outline'
                    size='sm'
                    onClick={handleSendClick}
                    disabled={!canSendToEdit}
                    className={cn(
                        'border-foreground/20 text-foreground/80 hover:bg-foreground/10 hover:text-foreground shrink-0 disabled:pointer-events-none disabled:opacity-50',
                        // Hide button completely if grid view is active and there are multiple images
                        showCarousel && viewMode === 'grid' ? 'invisible' : 'visible'
                    )}>
                    <Send className='mr-2 h-4 w-4' />
                    {t('Send to Edit')}
                </Button>
            </div>
        </div>
    );
}
