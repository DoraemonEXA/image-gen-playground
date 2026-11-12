'use client';

import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { ImageMode } from '@/lib/models';
import { usePreferences } from '@/modules/preferences/client';

type ModeToggleProps = {
    currentMode: ImageMode;
    onModeChange: (mode: ImageMode) => void;
};

export function ModeToggle({ currentMode, onModeChange }: ModeToggleProps) {
    const { t } = usePreferences();
    const active =
        'border-foreground bg-foreground text-background data-[state=active]:bg-foreground data-[state=active]:text-background dark:data-[state=active]:border-foreground dark:data-[state=active]:bg-foreground dark:data-[state=active]:text-background';
    return (
        <Tabs value={currentMode} onValueChange={(value) => onModeChange(value as ImageMode)} className='w-auto'>
            <TabsList className='grid h-auto grid-cols-2 gap-1 rounded-md border-none bg-transparent p-0'>
                <TabsTrigger
                    value='generate'
                    className={`rounded-md border px-3 py-1 text-sm transition-colors ${
                        currentMode === 'generate'
                            ? active
                            : 'border-foreground/30 text-foreground/60 hover:border-foreground/50 hover:text-foreground/80 border-dashed bg-transparent'
                    } `}>
                    {t('Generate')}
                </TabsTrigger>
                <TabsTrigger
                    value='edit'
                    className={`rounded-md border px-3 py-1 text-sm transition-colors ${
                        currentMode === 'edit'
                            ? active
                            : 'border-foreground/30 text-foreground/60 hover:border-foreground/50 hover:text-foreground/80 border-dashed bg-transparent'
                    } `}>
                    {t('Edit')}
                </TabsTrigger>
            </TabsList>
        </Tabs>
    );
}
