#!/usr/bin/env python3
"""Demo Cyclone DDS application for the visualiser.

Run it in an isolated domain, e.g.:
  python3 dds_demo.py --domain 87
Creates several named participants with different QoS, a keyed topic with
several instances, a ROS 2 style topic, and two readers whose QoS deliberately
does not match their writers (reliability, partition).
"""
import argparse
import math
import time
from dataclasses import dataclass, field

from cyclonedds.domain import DomainParticipant
from cyclonedds.idl import IdlEnum, IdlStruct
from cyclonedds.idl.annotations import key
from cyclonedds.idl.types import array, float32, float64, int32, sequence, uint8, uint32
from cyclonedds.pub import DataWriter, Publisher
from cyclonedds.qos import Policy, Qos
from cyclonedds.sub import DataReader, Subscriber
from cyclonedds.topic import Topic
from cyclonedds.util import duration


@dataclass
class MotorState(IdlStruct, typename='demo::MotorState'):
    q: float32 = 0.0
    dq: float32 = 0.0
    tau: float32 = 0.0
    temperature: uint8 = 0


@dataclass
class LowState(IdlStruct, typename='demo::LowState'):
    tick: uint32 = 0
    motors: array[MotorState, 6] = field(default_factory=lambda: [MotorState() for _ in range(6)])
    imu_rpy: array[float32, 3] = field(default_factory=lambda: [0.0, 0.0, 0.0])
    battery: float32 = 0.0
    crc: uint32 = 0


@dataclass
class LowCmd(IdlStruct, typename='demo::LowCmd'):
    q_target: array[float32, 6] = field(default_factory=lambda: [0.0] * 6)
    kp: float32 = 0.0
    kd: float32 = 0.0


@dataclass
class Imu(IdlStruct, typename='demo::Imu'):
    stamp: float64 = 0.0
    accel: array[float32, 3] = field(default_factory=lambda: [0.0, 0.0, 0.0])
    gyro: array[float32, 3] = field(default_factory=lambda: [0.0, 0.0, 0.0])


class Mode(IdlEnum, typename='demo::Mode'):
    IDLE = 0
    RUNNING = 1
    FAULT = 2


@dataclass
class DeviceStatus(IdlStruct, typename='demo::DeviceStatus'):
    device_id: int32 = 0
    key('device_id')
    name: str = ''
    mode: Mode = Mode.IDLE
    voltage: float32 = 0.0
    errors: sequence[uint8] = field(default_factory=list)


@dataclass
class String_(IdlStruct, typename='std_msgs::msg::dds_::String_'):
    data: str = ''


def participant(domain, name):
    return DomainParticipant(domain, qos=Qos(Policy.EntityName(name)))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--domain', type=int, default=87)
    args = ap.parse_args()
    d = args.domain

    rel = Qos(Policy.Reliability.Reliable(duration(milliseconds=100)), Policy.History.KeepLast(10))
    be = Qos(Policy.Reliability.BestEffort, Policy.History.KeepLast(5))
    latched = Qos(Policy.Reliability.Reliable(duration(milliseconds=100)), Policy.Durability.TransientLocal,
                  Policy.History.KeepLast(1))

    robot = participant(d, 'robot_driver')
    t_state = Topic(robot, 'rt/lowstate', LowState)
    t_imu = Topic(robot, 'rt/imu', Imu)
    w_state = DataWriter(robot, t_state, qos=rel)
    w_imu = DataWriter(robot, t_imu, qos=be)
    pub_robot = Publisher(robot, qos=Qos(Policy.Partition(['robot'])))
    w_status = DataWriter(pub_robot, Topic(robot, 'rt/device_status', DeviceStatus), qos=latched)
    w_chat = DataWriter(robot, Topic(robot, 'rt/chatter', String_), qos=rel)
    r_cmd = DataReader(robot, Topic(robot, 'rt/lowcmd', LowCmd), qos=rel)

    ctrl = participant(d, 'controller')
    r_state = DataReader(ctrl, Topic(ctrl, 'rt/lowstate', LowState), qos=rel)
    w_cmd = DataWriter(ctrl, Topic(ctrl, 'rt/lowcmd', LowCmd), qos=rel)
    r_imu_ok = DataReader(ctrl, Topic(ctrl, 'rt/imu', Imu), qos=be)

    mon = participant(d, 'monitor')
    # deliberate mismatches: reliable reader on a best-effort writer, wrong partition
    r_imu_bad = DataReader(mon, Topic(mon, 'rt/imu', Imu), qos=rel)
    sub_sim = Subscriber(mon, qos=Qos(Policy.Partition(['sim'])))
    r_status_bad = DataReader(sub_sim, Topic(mon, 'rt/device_status', DeviceStatus), qos=latched)
    sub_robot = Subscriber(mon, qos=Qos(Policy.Partition(['robot'])))
    r_status_ok = DataReader(sub_robot, Topic(mon, 'rt/device_status', DeviceStatus), qos=latched)

    keep = [r_cmd, r_state, r_imu_ok, r_imu_bad, r_status_bad, r_status_ok]  # noqa: F841 (keep readers alive)
    print(f'dds_demo running on domain {d}', flush=True)
    t0 = time.monotonic()
    tick = 0
    next_imu = next_status = next_chat = next_cmd = 0.0
    while True:
        t = time.monotonic() - t0
        motors = [MotorState(q=math.sin(t + 0.5 * k), dq=math.cos(t + 0.5 * k), tau=0.2 * math.sin(2 * t + k),
                             temperature=35 + k + int(3 * math.sin(t * 0.1))) for k in range(6)]
        w_state.write(LowState(tick=tick, motors=motors, imu_rpy=[0.05 * math.sin(t), 0.03 * math.cos(t), t % 6.28],
                               battery=48.0 - 0.01 * t % 5, crc=tick * 2654435761 % 2 ** 32))
        if t >= next_imu:
            next_imu = t + 0.01
            w_imu.write(Imu(stamp=time.time(), accel=[0.1 * math.sin(5 * t), 0.0, 9.81], gyro=[0.0, 0.0, 0.2 * math.cos(t)]))
        if t >= next_cmd:
            next_cmd = t + 0.02
            w_cmd.write(LowCmd(q_target=[math.sin(t + 0.5 * k) for k in range(6)], kp=40.0, kd=1.5))
        if t >= next_status:
            next_status = t + 0.5
            for i, name in enumerate(['left_arm', 'right_arm', 'base']):
                mode = Mode.FAULT if (i == 2 and int(t) % 20 > 16) else Mode.RUNNING
                w_status.write(DeviceStatus(device_id=i, name=name, mode=mode, voltage=47.5 + i * 0.2 + 0.1 * math.sin(t),
                                            errors=[1, 7] if mode == Mode.FAULT else []))
        if t >= next_chat:
            next_chat = t + 1.0
            w_chat.write(String_(data=f'hello from dds_demo {int(t)}'))
        tick += 1
        time.sleep(0.002)  # ~ 400-500 Hz lowstate


if __name__ == '__main__':
    main()
