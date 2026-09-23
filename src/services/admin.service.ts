import { pickupRepository } from "@/repositories/pickup.repository";
import { userRepository } from "@/repositories/user.repository";

export const adminService = {
  async getDashboard() {
    const [
      totalPickups,
      pendingPickups,
      assignedPickups,
      onTheWayPickups,
      arrivedPickups,
      completedPickups,
      cancelledPickups,
      pendingPayouts,
      paidPayouts,
      cancelledPayouts,
      totalCollectors,
      totalUsers,
    ] = await Promise.all([
      pickupRepository.countPickups(),
      pickupRepository.countPickupsByStatus("pending"),
      pickupRepository.countPickupsByStatus("assigned"),
      pickupRepository.countPickupsByStatus("on_the_way"),
      pickupRepository.countPickupsByStatus("arrived"),
      pickupRepository.countPickupsByStatus("completed"),
      pickupRepository.countPickupsByStatus("cancelled"),
      pickupRepository.countPayoutsByStatus("pending"),
      pickupRepository.countPayoutsByStatus("paid"),
      pickupRepository.countPayoutsByStatus("cancelled"),
      userRepository.countUsersByRole("collector"),
      userRepository.countUsersByRole("customer"),
    ]);

    return {
      pickups: {
        total: totalPickups,
        pending: pendingPickups,
        assigned: assignedPickups,
        on_the_way: onTheWayPickups,
        arrived: arrivedPickups,
        completed: completedPickups,
        cancelled: cancelledPickups,
      },

      payouts: {
        pending: pendingPayouts,
        paid: paidPayouts,
        cancelled: cancelledPayouts,
      },

      collectors: {
        total: totalCollectors,
      },
      users: {
        total: totalUsers,
      },
    };
  },
};
