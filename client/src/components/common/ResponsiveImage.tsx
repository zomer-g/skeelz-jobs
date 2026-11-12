import React from 'react';

interface ImageSource {
    src: string;
    width: number;
    maxViewportSize: number;
}

interface ResponsiveImageProps {
    srcSet: ImageSource[];
    alt: string;
    className?: string;
}

const ResponsiveImage: React.FC<ResponsiveImageProps> = ({ srcSet, alt, className }) => {
    const srcSetString = srcSet.map(src => `${src.src} ${src.width}w`).join(', ');
    const sizes = srcSet.map(src => `(max-width: ${src.maxViewportSize}px) ${src.maxViewportSize}px`).join(', ') + `, ${Math.max(...srcSet.map(src => src.maxViewportSize))}px`;

    return (
        <img
            srcSet={srcSetString}
            sizes={sizes}
            alt={alt}
            className={`img-fluid ${className}`}
        />
    );
};

export default ResponsiveImage;