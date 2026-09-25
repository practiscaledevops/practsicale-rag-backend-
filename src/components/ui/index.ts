// Shared UI primitives for the Brain back office. Import from "@/components/ui".
// (brain-ui.tsx is deliberately not re-exported: its legacy Th/Td collide with
// the Table primitives. Import it by path while it is being retired.)
export { Button, buttonClass, type ButtonProps, type ButtonVariant, type ButtonSize } from "./Button";
export { IconButton, type IconButtonProps } from "./IconButton";
export {
  Input,
  SearchInput,
  inputClass,
  compactFieldClass,
  type InputProps,
  type SearchInputProps,
  type FieldDensity,
} from "./Input";
export { Textarea, textareaClass, type TextareaProps } from "./Textarea";
export { Select, type SelectProps, type SelectOption, type SelectOptionGroup } from "./Select";
export { Label } from "./Label";
export { Field, type FieldProps } from "./Field";
export { Switch, SwitchRow, type SwitchProps, type SwitchRowProps } from "./Switch";
export { Checkbox, checkboxClass, type CheckboxProps } from "./Checkbox";
export { Segmented, type SegmentedProps, type SegmentedOption } from "./Segmented";
export {
  Tabs,
  TabPanel,
  FilterTabs,
  type TabItem,
  type TabsProps,
  type TabPanelProps,
  type FilterTabsProps,
} from "./Tabs";
export {
  Badge,
  StatusDot,
  Tag,
  ClassBadge,
  type BadgeProps,
  type BadgeTone,
  type StatusDotProps,
  type StatusDotTone,
} from "./Badge";
export {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
  SectionCard,
  type SectionCardProps,
} from "./Card";
export { PageHeader, type PageHeaderProps } from "./PageHeader";
export {
  StatTile,
  StatGrid,
  CompactStat,
  Meter,
  type StatTileProps,
  type StatTone,
  type MeterTone,
} from "./StatTile";
export {
  Table,
  THead,
  TBody,
  Tr,
  Th,
  Td,
  TableCard,
  TableEmptyRow,
  TableSkeletonRows,
  type TableProps,
  type TrProps,
  type ThProps,
  type TdProps,
  type TableCardProps,
} from "./Table";
export { EmptyState, type EmptyStateProps } from "./EmptyState";
export { Alert, Notice, InlineError, type AlertProps, type AlertTone } from "./Alert";
export { Dialog, type DialogProps, type DialogSize } from "./Dialog";
export {
  ConfirmDialog,
  useConfirm,
  type ConfirmDialogProps,
  type ConfirmOptions,
} from "./ConfirmDialog";
export { Menu, PopoverMenu, type MenuItem, type MenuProps, type PopoverMenuItem } from "./Menu";
export { Spinner, Skeleton } from "./Loading";
export { RelTime, useHydrated } from "./RelTime";
