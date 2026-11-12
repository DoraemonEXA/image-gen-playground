'use client';

import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { usePreferences } from '@/modules/preferences/client';
import * as React from 'react';

interface PasswordDialogProps {
    isOpen: boolean;
    onOpenChange: (isOpen: boolean) => void;
    onSave: (password: string) => void;
    title?: string;
    description?: string;
}

export function PasswordDialog({
    isOpen,
    onOpenChange,
    onSave,
    title = 'Configure Password',
    description
}: PasswordDialogProps) {
    const { t } = usePreferences();
    const [currentPassword, setCurrentPassword] = React.useState('');
    const inputRef = React.useRef<HTMLInputElement>(null);

    const handleSave = () => {
        inputRef.current?.blur();
        onSave(currentPassword);
        setCurrentPassword('');
        onOpenChange(false);
    };

    const handleDialogClose = (open: boolean) => {
        if (!open) {
            setCurrentPassword('');
        }
        onOpenChange(open);
    };

    return (
        <Dialog open={isOpen} onOpenChange={handleDialogClose}>
            <DialogContent className='border-foreground/20 bg-background text-foreground sm:max-w-[425px]'>
                <DialogHeader>
                    <DialogTitle className='text-foreground'>{t(title)}</DialogTitle>
                    {description && (
                        <DialogDescription className='text-foreground/60'>{t(description)}</DialogDescription>
                    )}
                </DialogHeader>
                <div className='grid gap-4 py-4'>
                    <div className='grid grid-cols-1 items-center gap-4'>
                        <Input
                            ref={inputRef}
                            id='password-input'
                            type='password'
                            placeholder={t('Enter your password')}
                            value={currentPassword}
                            onChange={(e) => setCurrentPassword(e.target.value)}
                            className='border-foreground/20 bg-background text-foreground placeholder:text-foreground/40 focus:border-foreground/50 focus:ring-foreground/50 col-span-1'
                            onKeyDown={(e) => {
                                if (e.key === 'Enter' && currentPassword.trim()) {
                                    e.preventDefault();
                                    handleSave();
                                }
                            }}
                        />
                    </div>
                </div>
                <DialogFooter>
                    <Button
                        type='button'
                        onClick={handleSave}
                        disabled={!currentPassword.trim()}
                        className='bg-foreground text-background hover:bg-foreground/90 disabled:bg-foreground/10 disabled:text-foreground/40 px-6'>
                        {t('Save')}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
