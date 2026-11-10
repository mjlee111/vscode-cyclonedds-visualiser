# Changelog

## 0.1.0

First Marketplace release.

- DDS Graph: participants (with host, process and PID) and topics, Participants / Active / All topics views, filters, host grouping, per-topic rates, PNG export.
- QoS mismatch detection for every writer/reader pair: type, reliability, durability, ownership, deadline, liveliness, destination order, data representation, partitions. Shown in the graph, the explorer, the topic monitor and the status bar.
- Topic Monitor: rate, period statistics, bandwidth and size of serialized samples, source-timestamp latency, endpoints with QoS, live samples decoded through XTypes type lookup, keyed instance selector, IDL view.
- Plot of numeric fields with field discovery from the resolved type.
- DDS Explorer (participants, topics, QoS mismatches) and status bar.
- Passive by default: best-effort readers only for the topics shown in open panels.
