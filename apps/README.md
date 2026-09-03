# Applications

## Purpose

Contains user-facing applications that are deployed and started directly.

## Components

- [Operator station](operator-station/README.md)
- [Mobile operator application](operator-mobile/README.md)
- [Control-plane API](control-plane-api/README.md)
- [Vertical-slice demo](vertical-slice-demo/README.md)
- [Interactive-autonomy demo](interactive-autonomy-demo/README.md)

Applications compose shared packages and call service/edge contracts. They do
not implement robot safety rules, vendor drivers, perception algorithms, or
durable workflow transitions locally.
