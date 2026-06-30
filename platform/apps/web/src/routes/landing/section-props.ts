import type { CSSProperties } from "react";

import type { ThemePreset } from "./content.js";

export type ThemeProps = {
  theme: ThemePreset;
};

export type LandingButtonProps = {
  appUrl: string;
  primaryButtonStyle: CSSProperties;
  outlineButtonStyle: CSSProperties;
};

export type HeroSectionProps = ThemeProps &
  LandingButtonProps & {
    elevatedSurfaceStyle: CSSProperties;
  };

export type FooterSectionProps = ThemeProps &
  LandingButtonProps & {
    themeIndex: number;
    onSelectTheme: (index: number) => void;
  };
