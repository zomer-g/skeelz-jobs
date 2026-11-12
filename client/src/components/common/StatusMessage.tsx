import React from 'react';
import { AlertCircleIcon, CheckContainedIcon } from '../../icons';

interface StatusMessageProps {
    message?: string;
    isError?: boolean;
    className?: string; // Optional className prop for custom styling
}

const StatusMessage: React.FC<StatusMessageProps> = ({ message, isError, className }) => (
    message ? (
        <p className={`${isError ? 'color-error' : 'color-success'} font-RubikMedium ${className || ''}`}>
            <span className="ms-2">
                {isError ? <AlertCircleIcon /> : <CheckContainedIcon />}
            </span>
            {message}
        </p>
    ) : null
);

export default StatusMessage;
